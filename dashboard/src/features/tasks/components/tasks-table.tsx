import { FILTER_PLACEHOLDER } from '@/product-config'
import { useEffect, useMemo, useState } from 'react'
import { getRouteApi } from '@tanstack/react-router'
import {
  type Row,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTableUrlState } from '@/hooks/use-table-url-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DataTablePagination, DataTableToolbar } from '@/components/data-table'
import { statuses } from '../data/data'
import { type Task } from '../data/schema'
import { DataTableBulkActions } from './data-table-bulk-actions'
import { RecoverySummary } from './recovery-summary'
import {
  documentTypeLabel,
  groupKeyFor,
  tasksColumns as columns,
} from './tasks-columns'
import { useTasks } from './tasks-provider'

const route = getRouteApi('/_authenticated/tasks/')

type DataTableProps = {
  data: Task[]
}

// A rate agreement covering several lanes collapses to one row, and that
// collapse happens here rather than in the table's row model.
//
// Grouping inside the model put sorting, selection and paging upstream of the
// leaves, which broke all three: sorting compared group rows that carry no leaf
// values, so clicking Name did nothing at all; select-all set selection on
// group rows, which getFilteredSelectedRowModel never returns, so the delete
// dialog read "Delete 0 tasks"; and the page counter measured groups instead of
// records, so 17 records read as 12.
type DisplayItem =
  | {
      type: 'group'
      key: string
      label: string
      count: number
      expanded: boolean
    }
  | { type: 'row'; row: Row<Task> }

export function TasksTable({ data }: DataTableProps) {
  // Local UI-only states
  const [rowSelection, setRowSelection] = useState({})
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    id: false,
    groupKey: false,
  })
  // Which collapsed groups the reader has opened. Keyed by the group key, so it
  // survives a re-sort or a filter change without resetting.
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {}
  )
  const { setOpen, setCurrentRow } = useTasks()

  // Synced with URL states (updated to match route search schema defaults)
  const {
    globalFilter,
    onGlobalFilterChange,
    columnFilters,
    onColumnFiltersChange,
    pagination,
    onPaginationChange,
    ensurePageInRange,
  } = useTableUrlState({
    search: route.useSearch(),
    navigate: route.useNavigate(),
    pagination: { defaultPage: 1, defaultPageSize: 10 },
    globalFilter: { enabled: true, key: 'filter' },
    columnFilters: [
      { columnId: 'status', searchKey: 'status', type: 'array' },
      { columnId: 'document_type', searchKey: 'document_type', type: 'array' },
    ],
  })

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
      globalFilter,
      pagination,
    },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    // The placeholder promises carrier, invoice, BOL or PO, but only title was
    // ever read and id is a hidden uuid, so searching an invoice number found
    // nothing. The values live in records.title and in details, which the
    // schema types loosely and the database has been known to store as a bare
    // string rather than an object.
    globalFilterFn: (row, _columnId, filterValue) => {
      const searchValue = String(filterValue).toLowerCase().trim()
      if (!searchValue) return true

      const task = row.original
      const details = (
        task.details && typeof task.details === 'object' ? task.details : {}
      ) as Record<string, unknown>

      return [
        task.title,
        task.source_file_path,
        details.invoice_number,
        details.bill_of_lading_pro_number,
      ].some(
        (value) =>
          typeof value === 'string' && value.toLowerCase().includes(searchValue)
      )
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    onPaginationChange,
    onGlobalFilterChange,
    onColumnFiltersChange,
  })

  // Options come from the data rather than a hardcoded list, so the filter
  // cannot drift from the values the poller actually writes.
  const documentFilterOptions = useMemo(() => {
    const labels = new Set<string>()
    for (const row of data) {
      const label = documentTypeLabel(row.details?.document_type)
      if (label) labels.add(label)
    }
    return Array.from(labels)
      .sort()
      .map((label) => ({ label, value: label }))
  }, [data])

  const pageCount = table.getPageCount()
  useEffect(() => {
    ensurePageInRange(pageCount)
  }, [pageCount, ensurePageInRange])

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: prev[key] !== true }))
  }

  // Lane counts are taken per page, not across the whole result set, because
  // that is what is on screen. A set of lanes split across a page boundary
  // arrives as a count of one on each page and is drawn as ordinary rows,
  // rather than leaving a header claiming lanes that are not in view.
  const pageRows = table.getRowModel().rows
  const laneCounts = new Map<string, number>()
  for (const row of pageRows) {
    const key = groupKeyFor(row.original)
    laneCounts.set(key, (laneCounts.get(key) ?? 0) + 1)
  }

  const displayRows: DisplayItem[] = []
  const groupsAlreadyDrawn = new Set<string>()
  for (const row of pageRows) {
    const key = groupKeyFor(row.original)
    const count = laneCounts.get(key) ?? 1

    if (count <= 1) {
      // An invoice, or a rate agreement covering a single lane. There is
      // nothing to collapse, so it draws as the record it is.
      displayRows.push({ type: 'row', row })
      continue
    }

    const expanded = expandedGroups[key] === true
    if (!groupsAlreadyDrawn.has(key)) {
      groupsAlreadyDrawn.add(key)
      displayRows.push({
        type: 'group',
        key,
        label: String(row.original.title ?? 'Rate agreement'),
        count,
        expanded,
      })
    }
    // The header stands in for its lanes while it is closed.
    if (expanded) displayRows.push({ type: 'row', row })
  }

  const columnCount = table.getVisibleLeafColumns().length

  return (
    <div
      className={cn(
        'max-sm:has-[div[role="toolbar"]]:mb-16', // Add margin bottom to the table on mobile when the toolbar is visible
        'flex flex-1 flex-col gap-4'
      )}
    >
      <RecoverySummary data={data} />
      <DataTableToolbar
        table={table}
        searchPlaceholder={FILTER_PLACEHOLDER}
        filters={[
          {
            columnId: 'status',
            title: 'Status',
            options: statuses,
          },
          ...(documentFilterOptions.length > 0
            ? [
                {
                  columnId: 'document_type',
                  title: 'Document',
                  options: documentFilterOptions,
                },
              ]
            : []),
        ]}
      />
      <div className='overflow-hidden rounded-md border'>
        <Table className='min-w-xl'>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      className={cn(
                        header.column.columnDef.meta?.className,
                        header.column.columnDef.meta?.thClassName
                      )}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {displayRows.length ? (
              displayRows.map((item) => {
                if (item.type === 'group') {
                  return (
                    <TableRow
                      key={`group-${item.key}`}
                      className='cursor-pointer bg-muted/40'
                      onClick={() => toggleGroup(item.key)}
                    >
                      <TableCell colSpan={columnCount}>
                        <div className='flex items-center gap-2 text-sm'>
                          {item.expanded ? (
                            <ChevronDown className='size-4 shrink-0' />
                          ) : (
                            <ChevronRight className='size-4 shrink-0' />
                          )}
                          <span className='font-medium'>{item.label}</span>
                          <span className='text-muted-foreground'>
                            {item.count} lanes
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                }

                const row = item.row
                return (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() && 'selected'}
                    className='cursor-pointer'
                    onClick={(event) => {
                      // Only a click on the row itself opens the panel. The
                      // checkbox, the source-file button and the actions menu
                      // keep their own behaviour.
                      if (
                        (event.target as HTMLElement).closest(
                          'button, a, input, [role="checkbox"], [role="menuitem"]'
                        )
                      ) {
                        return
                      }
                      setCurrentRow(row.original)
                      setOpen('view')
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          cell.column.columnDef.meta?.className,
                          cell.column.columnDef.meta?.tdClassName
                        )}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className='h-24 text-center'
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination table={table} className='mt-auto' />
      <DataTableBulkActions table={table} />
    </div>
  )
}

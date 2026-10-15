import { FILTER_PLACEHOLDER } from '@/product-config'
import { useEffect, useMemo, useState } from 'react'
import { getRouteApi } from '@tanstack/react-router'
import {
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
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
import { documentTypeLabel, tasksColumns as columns } from './tasks-columns'
import { useTasks } from './tasks-provider'

const route = getRouteApi('/_authenticated/tasks/')

type DataTableProps = {
  data: Task[]
}

export function TasksTable({ data }: DataTableProps) {
  // Local UI-only states
  const [rowSelection, setRowSelection] = useState({})
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
    id: false,
    groupKey: false,
  })
  const { setOpen, setCurrentRow } = useTasks()

  // Local state management for table (uncomment to use local-only state, not synced with URL)
  // const [globalFilter, onGlobalFilterChange] = useState('')
  // const [columnFilters, onColumnFiltersChange] = useState<ColumnFiltersState>([])
  // const [pagination, onPaginationChange] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 })

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
    initialState: { grouping: ['groupKey'] },
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    globalFilterFn: (row, _columnId, filterValue) => {
      const id = String(row.getValue('id')).toLowerCase()
      const title = String(row.getValue('title')).toLowerCase()
      const searchValue = String(filterValue).toLowerCase()

      return id.includes(searchValue) || title.includes(searchValue)
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
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

  return (
    <div
      className={cn(
        'max-sm:has-[div[role="toolbar"]]:mb-16', // Add margin bottom to the table on mobile when the toolbar is visible
        'flex flex-1 flex-col gap-4'
      )}
    >
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
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className={cn('cursor-pointer', row.getIsGrouped() && 'bg-muted/40')}
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
                    // A group row is a rate agreement, not a record, so it
                    // has nothing of its own to show. It opens instead.
                    if (row.getIsGrouped()) {
                      row.toggleExpanded()
                      return
                    }
                    setCurrentRow(row.original)
                    setOpen('view')
                  }}
                >
                  {row.getIsGrouped() ? (
                    <TableCell colSpan={row.getVisibleCells().length}>
                      <div className='flex items-center gap-2 text-sm'>
                        {row.getIsExpanded() ? (
                          <ChevronDown className='size-4 shrink-0' />
                        ) : (
                          <ChevronRight className='size-4 shrink-0' />
                        )}
                        <span className='font-medium'>
                          {row.subRows[0]?.original.title ?? 'Rate agreement'}
                        </span>
                        <span className='text-muted-foreground'>
                          {row.subRows.length} lane
                          {row.subRows.length === 1 ? '' : 's'}
                        </span>
                      </div>
                    </TableCell>
                  ) : (
                    row.getVisibleCells().map((cell) => (
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
                    ))
                  )}
                </TableRow>
              ))
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

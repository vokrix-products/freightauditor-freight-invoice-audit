import { type ColumnDef } from '@tanstack/react-table'
import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTableColumnHeader } from '@/components/data-table'
import { firstNote } from '@/lib/format'
import { statuses, severityToBadgeVariant } from '../data/data'
import { type Task } from '../data/schema'
import { DataTableRowActions } from './data-table-row-actions'
import { openSourceFile } from './open-source-file'

function formatDueDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  const now = new Date()
  const diffDays = Math.ceil(
    (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  )
  const label = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  if (diffDays < 0) return `${label} (overdue)`
  if (diffDays <= 30) return `${label} (${diffDays}d)`
  return label
}

// A record is either an invoice or a rate agreement, and the two mean different
// things: a rate agreement is what later invoices are checked against.
// The poller writes the classification to details.document_type, which the
// fetch already returns, so labelling a row needs no change to the query.
export function documentTypeLabel(value: unknown): string {
  if (value === 'rate_sheet') return 'Rate agreement'
  if (value === 'invoice') return 'Invoice'
  if (typeof value === 'string' && value.trim()) {
    return value
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return ''
}

// A rate agreement is expanded into one record per contracted lane, so six rows
// carrying the same carrier, note, type, status and date are six different
// lanes, not six copies of one file. Nothing on the row said which lane, which
// made the list look like it had repeated itself. The lane is also the field the
// audit matches an invoice against, so it belongs on the row for both types.
export function laneLabel(row: Task): string {
  const details = row.details
  const parts =
    details?.document_type === 'rate_sheet'
      ? [details?.origin_zone_zip_postal, details?.destination_zone_zip_postal]
      : [details?.origin_location, details?.destination_location]
  const [origin, destination] = parts.map((part) =>
    typeof part === 'string' ? part.trim() : ''
  )
  if (origin && destination) return `${origin} \u2192 ${destination}`
  return origin || destination || ''
}

// Every column carries the heading a person reads in meta.title, because the
// CSV export writes its header row from there. The React header above it is a
// render function, which an export cannot read.
export const tasksColumns: ColumnDef<Task>[] = [
  {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && 'indeterminate')
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label='Select all'
        className='translate-y-0.5'
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label='Select row'
        className='translate-y-0.5'
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: 'id',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='ID' />
    ),
    cell: ({ row }) => <div className='w-20'>{row.getValue('id')}</div>,
    enableSorting: false,
    enableHiding: true,
    meta: { title: 'ID' },
  },
  {
    accessorKey: 'title',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='Name' />
    ),
    meta: {
      title: 'Name',
      className: 'ps-1 max-w-0 w-2/3',
      tdClassName: 'ps-4',
    },
    cell: ({ row }) => {
      // The poller explains itself in details._notes (e.g. "total charges do
      // not match freight+fuel+accessorial"). Showing the first note under the
      // name means a flagged row says why it was flagged without a drill-down.
      const note = firstNote(row.original.details?._notes)
      return (
        <div className='flex flex-col gap-0.5'>
          <span className='truncate font-medium'>{row.getValue('title')}</span>
          {note && (
            <span className='truncate text-xs text-muted-foreground'>
              {note}
            </span>
          )}
        </div>
      )
    },
  },
  {
    id: 'document_type',
    // Label rather than the raw value, because 'rate_sheet' reads as jargon.
    // Filtering happens on the label, so the filter options are derived from
    // the loaded rows in tasks-table and always match what is on screen.
    accessorFn: (row) => documentTypeLabel(row.details?.document_type),
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='Document' />
    ),
    meta: { title: 'Document', className: 'ps-1', tdClassName: 'ps-4' },
    cell: ({ row }) => {
      const label = String(row.getValue('document_type') ?? '')
      return (
        <span className='text-sm text-muted-foreground'>{label || '\u2014'}</span>
      )
    },
    filterFn: (row, id, value) =>
      (value as string[]).includes(String(row.getValue(id))),
  },
  {
    id: 'lane',
    accessorFn: (row) => laneLabel(row),
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='Lane' />
    ),
    meta: { title: 'Lane', className: 'ps-1 max-w-0 w-1/4', tdClassName: 'ps-4' },
    cell: ({ row }) => {
      const label = String(row.getValue('lane') ?? '')
      if (!label) {
        return <span className='text-muted-foreground'>{'\u2014'}</span>
      }
      return (
        <span className='truncate text-xs text-muted-foreground' title={label}>
          {label}
        </span>
      )
    },
    enableSorting: false,
  },
  {
    accessorKey: 'status',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='Status' />
    ),
    meta: { title: 'Status', className: 'ps-1', tdClassName: 'ps-4' },
    cell: ({ row }) => {
      const statusValue = row.getValue('status') as string
      const statusDef = statuses.find((s) => s.value === statusValue)
      const severity = statusDef?.severity ?? 'neutral'
      const badgeVariant = severityToBadgeVariant[severity]
      const Icon = statusDef?.icon
      return (
        <div className='flex w-32 items-center gap-2'>
          <Badge variant={badgeVariant} className='flex items-center gap-1'>
            {Icon && <Icon className='size-3' />}
            {statusDef?.label ?? statusValue}
          </Badge>
        </div>
      )
    },
    filterFn: (row, id, value) => value.includes(row.getValue(id)),
  },
  {
    // PRODUCT_CUSTOMIZE: show due_date column only for products where records
    // have expiration/renewal/deadline dates (COI, credentialing, permits,
    // insurance). Remove this column definition for products without dates.
    accessorKey: 'due_date',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='Due / Expires' />
    ),
    meta: { title: 'Due / Expires', className: 'ps-1', tdClassName: 'ps-4' },
    cell: ({ row }) => {
      const val = row.getValue('due_date') as string | null | undefined
      const formatted = formatDueDate(val)
      if (!formatted) return <span className='text-muted-foreground'>\u2014</span>
      const isOverdue = formatted.includes('overdue')
      const isSoon =
        !isOverdue && formatted.includes('d)') && parseInt(formatted.split('(')[1]) <= 30
      // One column carries two different dates: an invoice's payment due date,
      // and a rate agreement's expiry. The header names the column, not which
      // date a given row is showing. When the document type could not be read
      // there is nothing to say, so no caption is shown rather than guessing.
      const documentType = row.original.details?.document_type
      const caption =
        documentType === 'rate_sheet'
          ? 'Agreement expires'
          : documentType === 'invoice'
            ? 'Invoice due'
            : null
      return (
        <div className='flex flex-col gap-0.5'>
          <span
            className={
              isOverdue
                ? 'text-destructive font-medium'
                : isSoon
                  ? 'text-warning font-medium'
                  : 'text-foreground'
            }
          >
            {formatted}
          </span>
          {caption && (
            <span className='text-xs text-muted-foreground'>{caption}</span>
          )}
        </div>
      )
    },
  },
  {
    // PRODUCT_CUSTOMIZE: source document link. Keep for any product that
    // extracts data from uploaded documents (PDFs, CSVs). The poller must
    // write the original upload path to records.source_file_path.
    id: 'source',
    header: () => <span className='text-xs text-muted-foreground'>Source</span>,
    meta: { title: 'Source' },
    cell: ({ row }) => {
      const path = row.original.source_file_path
      if (!path) return null
      return (
        <Button
          variant='ghost'
          size='sm'
          className='h-7 px-2'
          onClick={() => openSourceFile(path)}
        >
          <ExternalLink className='size-3.5 mr-1' />
          View
        </Button>
      )
    },
    enableSorting: false,
    enableHiding: true,
  },

  {
    id: 'actions',
    cell: ({ row }) => <DataTableRowActions row={row} />,
  },
]

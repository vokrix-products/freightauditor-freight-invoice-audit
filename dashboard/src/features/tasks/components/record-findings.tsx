import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatCurrency, noteList, toNumber } from '@/lib/format'
import { statuses, severityToBadgeVariant } from '../data/data'
import { type Task } from '../data/schema'

// Field names written for a person reading an invoice, not for the poller.
const FIELD_LABELS: Record<string, string> = {
  invoice_number: 'Invoice number',
  bill_of_lading_pro_number: 'BOL / PRO number',
  document_type: 'Document type',
  ship_date: 'Ship date',
  effective_date: 'Effective date',
  expiration_date: 'Expiration date',
  origin_location: 'Origin',
  destination_location: 'Destination',
  origin_zone_zip_postal: 'Origin ZIP',
  destination_zone_zip_postal: 'Destination ZIP',
  actual_weight: 'Actual weight',
  billable_weight: 'Billable weight',
  freight_class_commodity: 'Commodity',
  base_rate: 'Contracted base rate',
  rate_basis: 'Rate basis',
  minimum_charge: 'Minimum charge',
  freight_charge: 'Freight charge',
  fuel_surcharge: 'Fuel surcharge',
  accessorial_charges: 'Accessorial charges',
  discount_amount: 'Discount',
  total_charges: 'Total charges',
  overcharge_amount: 'Overcharge',
  matched_rate_line_reference: 'Matched contract line',
  contract_rate_sheet_identifier: 'Contract',
  currency: 'Currency',
}

// Anything not named above follows, in this order first.
const FIELD_ORDER = [
  'invoice_number',
  'bill_of_lading_pro_number',
  'document_type',
  'ship_date',
  'effective_date',
  'expiration_date',
  'origin_location',
  'destination_location',
  'origin_zone_zip_postal',
  'destination_zone_zip_postal',
  'actual_weight',
  'billable_weight',
  'freight_class_commodity',
  'rate_basis',
  'base_rate',
  'minimum_charge',
  'freight_charge',
  'fuel_surcharge',
  'accessorial_charges',
  'discount_amount',
  'total_charges',
  'overcharge_amount',
  'matched_rate_line_reference',
  'contract_rate_sheet_identifier',
  'currency',
]

// Never shown. The underscore keys are the poller talking to itself, and the
// fuel table is the contract's own bands rather than anything about this file.
const HIDDEN_FIELDS = new Set(['_rate_line_index', 'fuel_surcharge_table'])

const CURRENCY_FIELDS = new Set([
  'base_rate',
  'minimum_charge',
  'freight_charge',
  'fuel_surcharge',
  'accessorial_charges',
  'discount_amount',
  'total_charges',
  'overcharge_amount',
])

const WEIGHT_FIELDS = new Set(['actual_weight', 'billable_weight'])

function asRecord(details: unknown): Record<string, unknown> {
  if (typeof details === 'string') {
    try {
      const parsed: unknown = JSON.parse(details)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    return details as Record<string, unknown>
  }
  return {}
}

function asLineItems(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (v): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v)
  )
}

function label(key: string): string {
  return (
    FIELD_LABELS[key] ??
    key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  )
}

function displayValue(key: string, value: unknown): string {
  if (CURRENCY_FIELDS.has(key)) {
    const money = formatCurrency(value)
    if (money) return money
  }
  if (WEIGHT_FIELDS.has(key)) {
    // A weight may arrive as a number or as a formatted string like
    // "12,480 lbs", so it goes through toNumber() like every other numeric
    // read rather than trusting the shape.
    const pounds = toNumber(value)
    if (pounds !== null) return `${pounds.toLocaleString()} lbs`
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

export function RecordFindings({ task }: { task: Task }) {
  const details = asRecord(task.details)
  const notes = noteList(details._notes)
  const lineItems = asLineItems(details.invoice_line_items)

  const statusDef = statuses.find((s) => s.value === task.status)
  const severity = statusDef?.severity ?? 'neutral'

  // toNumber(), not Number(). The poller may write a formatted string such as
  // "$1,467.64", and Number() turns that into NaN - which would silently hide
  // the overcharge box instead of showing the figure it was calculated from.
  const overcharge = toNumber(details.overcharge_amount)
  const hasOvercharge = overcharge !== null && overcharge > 0

  const entries = Object.entries(details)
    .filter(([key]) => !HIDDEN_FIELDS.has(key))
    .filter(([key]) => !key.startsWith('_'))
    .filter(([key]) => key !== 'invoice_line_items')
    .filter(([, value]) => value !== null && value !== '' && value !== undefined)
    .sort(([a], [b]) => {
      const ia = FIELD_ORDER.indexOf(a)
      const ib = FIELD_ORDER.indexOf(b)
      if (ia === -1 && ib === -1) return a.localeCompare(b)
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    })

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <Badge variant={severityToBadgeVariant[severity]}>
          {statusDef?.label ?? task.status}
        </Badge>
        <span className='text-xs text-muted-foreground'>
          {entries.length} field{entries.length === 1 ? '' : 's'} extracted
        </span>
      </div>

      {/* The findings. Every entry is a check that failed, with the figures it
          failed on - the poller only records failures, so absence of a note
          means nothing failed rather than everything passing. */}
      <div className='rounded-md border bg-muted/40 px-3 py-2'>
        <p className='text-xs font-medium text-muted-foreground'>Findings</p>
        {notes.length === 0 ? (
          <p className='mt-1 flex items-center gap-1.5 text-sm text-muted-foreground'>
            <CheckCircle2 className='size-3.5 text-emerald-500' />
            No issues found on this document.
          </p>
        ) : (
          <ul className='mt-1 space-y-1'>
            {notes.map((note) => (
              <li key={note} className='flex gap-1.5 text-sm'>
                <AlertTriangle className='mt-0.5 size-3.5 shrink-0 text-warning' />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {hasOvercharge && (
        <div className='rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2'>
          <p className='text-xs font-medium text-muted-foreground'>
            Billed above the contracted rate
          </p>
          <p className='text-lg font-semibold'>
            {formatCurrency(overcharge)}
          </p>
        </div>
      )}

      {lineItems.length > 0 && (
        <div className='rounded-md border'>
          <p className='border-b px-3 py-2 text-xs font-medium text-muted-foreground'>
            Line items
          </p>
          <div className='divide-y'>
            {lineItems.map((item, index) => {
              const pounds = toNumber(item.weight)
              const ratePerHundred = toNumber(item.rate_per_100lbs)
              return (
                <div key={index} className='px-3 py-2 text-xs'>
                  <div className='flex justify-between gap-3'>
                    <span className='font-medium'>
                      {String(item.description ?? 'Unnamed line')}
                    </span>
                    <span className='shrink-0 font-medium'>
                      {formatCurrency(item.amount) ?? String(item.amount ?? '\u2014')}
                    </span>
                  </div>
                  <div className='mt-0.5 flex flex-wrap gap-x-3 text-muted-foreground'>
                    {item.freight_class !== undefined && (
                      <span>Class {String(item.freight_class)}</span>
                    )}
                    {pounds !== null && (
                      <span>{pounds.toLocaleString()} lbs</span>
                    )}
                    {ratePerHundred !== null && (
                      <span>{formatCurrency(ratePerHundred)}/100lbs</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <div className='rounded-md border bg-muted/40 px-3 py-2 space-y-1'>
          {entries.map(([key, value]) => (
            <div key={key} className='flex gap-2 text-xs'>
              <span className='min-w-32 shrink-0 text-muted-foreground'>
                {label(key)}
              </span>
              <span className='font-medium break-words'>
                {displayValue(key, value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

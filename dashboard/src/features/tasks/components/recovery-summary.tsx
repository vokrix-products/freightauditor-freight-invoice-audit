import { formatCurrency, noteList, toNumber } from '@/lib/format'
import { type Task } from '../data/schema'

function detailsRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function noteText(details: Record<string, unknown>): string {
  return noteList(details._notes).join(' ').toLowerCase()
}

// What the records on screen add up to, and - more useful - what they do not.
//
// Every figure comes from the audit's own output: the rate line it matched, the
// status it assigned, and overcharge_amount. Nothing is recalculated, so this
// cannot report a recovery the audit did not record.
//
// Coverage is shown first and deliberately, because a record the audit could
// not compare to a contract is not a clean record. Without this line, one
// overcharge in twenty-six invoices reads as a tool that found almost nothing,
// when in fact it had nothing to compare twenty-three of them against.
export function RecoverySummary({ data }: { data: Task[] }) {
  if (!data.length) return null

  let audited = 0
  let flagged = 0
  let priced = 0
  let duplicates = 0
  let incomplete = 0
  let total = 0
  const perCarrier = new Map<string, number>()

  for (const task of data) {
    const details = detailsRecord(task.details)

    // matched_rate_line_reference is written only when the audit found the
    // invoice's lane on a rate sheet. Its absence means the invoice was never
    // priced, not that it was correct.
    if (String(details.matched_rate_line_reference ?? '').trim()) audited += 1

    const notes = noteText(details)
    if (notes.includes('duplicate')) duplicates += 1
    if (notes.includes('missing required field')) incomplete += 1

    if (String(task.status ?? '').startsWith('flagged')) flagged += 1

    const amount = toNumber(details.overcharge_amount)
    if (amount === null || amount <= 0) continue
    priced += 1
    total += amount
    const carrier = String(task.title ?? '').trim() || 'Carrier not named'
    perCarrier.set(carrier, (perCarrier.get(carrier) ?? 0) + amount)
  }

  const unaudited = data.length - audited
  const otherFlags = flagged - priced

  const top = Array.from(perCarrier.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)

  return (
    <div className='rounded-md border bg-muted/30 px-4 py-3'>
      <div className='flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm'>
        <span className='text-muted-foreground'>
          {data.length} record{data.length === 1 ? '' : 's'} loaded
        </span>
        <span>
          <span className='font-medium'>
            {audited} of {data.length}
          </span>{' '}
          <span className='text-muted-foreground'>compared to a contract</span>
        </span>
        {unaudited > 0 && (
          <span className='text-amber-700 dark:text-amber-500'>
            <span className='font-medium'>{unaudited}</span> with no rate
            agreement matched
          </span>
        )}
        <span>
          <span className='font-medium'>{flagged}</span>{' '}
          <span className='text-muted-foreground'>flagged</span>
        </span>
        <span>
          <span className='font-medium'>{priced}</span>{' '}
          <span className='text-muted-foreground'>with money at stake</span>
        </span>
        <span>
          <span className='text-muted-foreground'>Identified overcharge</span>{' '}
          <span
            className={
              total > 0 ? 'font-semibold text-destructive' : 'font-semibold'
            }
          >
            {formatCurrency(total) ?? formatCurrency(0)}
          </span>
        </span>
        {top.map(([name, amount]) => (
          <span key={name} className='text-muted-foreground'>
            {name} {formatCurrency(amount)}
          </span>
        ))}
      </div>

      <p className='mt-1 text-xs text-muted-foreground'>
        {unaudited > 0
          ? `${unaudited} record${unaudited === 1 ? ' was' : 's were'} not compared to a contracted rate, so ${unaudited === 1 ? 'it is' : 'they are'} unaudited rather than clean. Upload the carrier's rate agreement to audit ${unaudited === 1 ? 'it' : 'them'}. `
          : 'Every loaded record was compared to a contracted rate. '}
        {otherFlags > 0
          ? `${otherFlags} of the ${flagged} flags carry no money figure - ${duplicates} duplicate${duplicates === 1 ? '' : 's'} and ${incomplete} incomplete document${incomplete === 1 ? '' : 's'} among them.`
          : 'Carrier figures name up to three carriers by amount.'}
      </p>
    </div>
  )
}

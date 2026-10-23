import { formatCurrency, toNumber } from '@/lib/format'
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

// What the records on screen add up to.
//
// Every figure comes from the audit's own output - status and overcharge_amount
// - so this cannot report a recovery the audit did not record. It totals what is
// loaded here, which is what a controller can see, not the whole account.
export function RecoverySummary({ data }: { data: Task[] }) {
  if (!data.length) return null

  let flagged = 0
  let priced = 0
  let total = 0
  const perCarrier = new Map<string, number>()

  for (const task of data) {
    if (String(task.status ?? '').startsWith('flagged')) flagged += 1
    const amount = toNumber(detailsRecord(task.details).overcharge_amount)
    if (amount === null || amount <= 0) continue
    priced += 1
    total += amount
    const carrier = String(task.title ?? '').trim() || 'Carrier not named'
    perCarrier.set(carrier, (perCarrier.get(carrier) ?? 0) + amount)
  }

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
          <span className='font-medium'>{flagged}</span>{' '}
          <span className='text-muted-foreground'>flagged</span>
        </span>
        <span>
          <span className='font-medium'>{priced}</span>{' '}
          <span className='text-muted-foreground'>priced above contract</span>
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
        Totalled from the findings the audit recorded on the records loaded
        here. Carrier figures name up to three carriers by amount.
      </p>
    </div>
  )
}

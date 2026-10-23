import { useEffect, useState } from 'react'

import { formatCurrency, toNumber } from '@/lib/format'
import { type Task } from '../data/schema'
import {
  CLAIM_EVENT_NAME,
  CLAIM_STATE_LABELS,
  CLAIM_STATE_ORDER,
  loadClaimEvents,
  type ClaimEvent,
  type ClaimState,
} from './claim-events'

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
// Every figure comes from the audit's own output - status and overcharge_amount -
// so this cannot report a recovery the audit did not record. It totals what is
// loaded here, which is what a controller can see, not the whole account.
//
// The claim states below are scoped to the same set of records for the same
// reason: a credited total that counted records not on screen would not
// reconcile against the overcharge figure printed above it.
export function RecoverySummary({ data }: { data: Task[] }) {
  const [claims, setClaims] = useState<Map<string, ClaimEvent>>(new Map())

  // Declared before the early return so the hook order is stable across a
  // render where data is empty and one where it is not.
  useEffect(() => {
    let alive = true
    const load = () => {
      void loadClaimEvents().then((next) => {
        if (alive) setClaims(next)
      })
    }
    load()
    window.addEventListener(CLAIM_EVENT_NAME, load)
    return () => {
      alive = false
      window.removeEventListener(CLAIM_EVENT_NAME, load)
    }
  }, [])

  if (!data.length) return null

  let flagged = 0
  let priced = 0
  let total = 0
  const perCarrier = new Map<string, number>()
  const onScreen = new Set<string>()

  for (const task of data) {
    onScreen.add(String(task.id))
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

  const claimStates = new Map<ClaimState, { count: number; amount: number }>()
  let claimedOffscreen = 0

  for (const event of claims.values()) {
    if (!onScreen.has(event.recordId)) {
      claimedOffscreen += 1
      continue
    }
    const bucket = claimStates.get(event.state) ?? { count: 0, amount: 0 }
    bucket.count += 1
    bucket.amount += event.amount ?? 0
    claimStates.set(event.state, bucket)
  }

  const hasClaims = claimStates.size > 0

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
      {hasClaims && (
        <div className='mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t pt-2 text-sm'>
          <span className='text-muted-foreground'>Claims on these records</span>
          {CLAIM_STATE_ORDER.filter((state) => claimStates.has(state)).map(
            (state) => {
              const bucket = claimStates.get(state)
              if (!bucket) return null
              const money = state === 'credited' || state === 'denied'
              return (
                <span key={state}>
                  <span
                    className={
                      state === 'credited'
                        ? 'font-medium text-emerald-600'
                        : state === 'denied'
                          ? 'font-medium text-destructive'
                          : 'font-medium'
                    }
                  >
                    {bucket.count}
                  </span>{' '}
                  <span className='text-muted-foreground'>
                    {CLAIM_STATE_LABELS[state]}
                    {money && bucket.amount > 0
                      ? ` (${formatCurrency(bucket.amount)})`
                      : ''}
                  </span>
                </span>
              )
            }
          )}
        </div>
      )}
      <p className='mt-1 text-xs text-muted-foreground'>
        Totalled from the findings the audit recorded on the records loaded
        here. Carrier figures name up to three carriers by amount.
        {hasClaims
          ? ' Claim states are read from the audit log and cover the same records.'
          : ''}
        {claimedOffscreen > 0
          ? ` ${claimedOffscreen} further claim${claimedOffscreen === 1 ? '' : 's'} exist on records not shown here.`
          : ''}
      </p>
    </div>
  )
}

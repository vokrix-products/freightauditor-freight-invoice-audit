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

// A rate agreement is the yardstick the invoices are measured against, not an
// invoice that can be overbilled. Counting the two together made a single
// audited invoice read "1 of 2 compared to a contract" on the screen a buyer
// sees first, which looks like the audit failed when it had in fact succeeded.
function isRateAgreement(details: Record<string, unknown>): boolean {
  return String(details.document_type ?? '').trim() === 'rate_sheet'
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
    // The event above is same-tab only, so a claim set in another tab was
    // invisible here until a full reload.
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.removeEventListener(CLAIM_EVENT_NAME, load)
      window.removeEventListener('focus', load)
    }
  }, [])

  if (!data.length) return null

  let invoices = 0
  let agreements = 0
  let flagged = 0
  let flaggedNoMoney = 0
  let compared = 0
  let priced = 0
  let total = 0
  const perCarrier = new Map<string, number>()
  const onScreen = new Set<string>()

  for (const task of data) {
    onScreen.add(String(task.id))
    const details = detailsRecord(task.details)
    if (isRateAgreement(details)) {
      agreements += 1
      continue
    }
    invoices += 1

    const amount = toNumber(details.overcharge_amount)
    const isFlagged = String(task.status ?? '').startsWith('flagged')
    if (isFlagged) flagged += 1

    // A rate line is only recorded when the audit found the contracted lane, so
    // this counts the invoices a contract could actually be checked against.
    // The remainder were never compared to anything: they are unaudited, not
    // clean, and rendering both the same way made unexamined invoices look like
    // a clean bill of health.
    if (String(details.matched_rate_line_reference ?? '').trim()) compared += 1

    if (amount === null || amount <= 0) {
      // A flag with no money behind it is a data problem - a missing field, a
      // repeated upload - and reading it as a recovery overstates the finding.
      if (isFlagged) flaggedNoMoney += 1
      continue
    }
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
  const unaudited = invoices - compared

  return (
    <div className='rounded-md border bg-muted/30 px-4 py-3'>
      <div className='flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm'>
        <span className='text-muted-foreground'>
          {invoices} invoice{invoices === 1 ? '' : 's'} loaded
        </span>
        <span>
          <span className='font-medium'>
            {compared} of {invoices}
          </span>{' '}
          <span className='text-muted-foreground'>compared to a contract</span>
        </span>
        {unaudited > 0 && (
          <span className='font-medium text-amber-600'>
            {unaudited} with no rate line matched
          </span>
        )}
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
        {agreements > 0 && (
          <span className='text-muted-foreground'>
            {agreements} rate agreement{agreements === 1 ? '' : 's'} on file
          </span>
        )}
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
        Totalled from the findings the audit recorded on the invoices loaded
        here. Carrier figures name up to three carriers by amount.
        {unaudited > 0
          ? ` ${unaudited} of these had no rate line matched, so no contract was applied to them - they are unaudited rather than clean. Upload the rate agreement for those lanes to include them.`
          : ''}
        {flaggedNoMoney > 0
          ? ` ${flaggedNoMoney} flag${flaggedNoMoney === 1 ? '' : 's'} carry no money and are data issues, not recoveries.`
          : ''}
        {agreements > 0
          ? ` The ${agreements} rate agreement${agreements === 1 ? '' : 's'} on file ${agreements === 1 ? 'is' : 'are'} listed below but not counted as invoices.`
          : ''}
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

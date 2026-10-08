import { useQuery } from '@tanstack/react-query'
import { supabase, PRODUCT_ID } from '@/lib/supabase'
import { toNumber } from '@/lib/format'
import { statuses } from '@/features/tasks/data/data'

export interface DashboardRecord {
  id: string
  title: string
  status: string
  created_at: string
}

export interface UpcomingRecord {
  id: string
  title: string
  status: string
  due_date: string
}

// One rate agreement, collapsed from the row-per-lane shape the poller writes.
export interface RateAgreement {
  title: string
  laneCount: number
  status: string
  expiry: string | null
}

export interface DashboardStats {
  total: number
  // Rows classified as invoices. `total` counts rate agreements as well, so a
  // card titled after invoices must not read from it: one customer had 17
  // records, of which 8 were rate-agreement lanes rather than audits.
  invoiceCount: number
  invoiceCountPrevWeek: number
  needsAttention: number
  addedThisWeek: number
  addedPrevWeek: number
  totalPrevWeek: number
  needsAttentionPrevWeek: number
  // Rate sheets are counted once per agreement rather than once per lane; every
  // other row counts as itself. Counting lanes made the Expired bar read 6 while
  // the Rate Agreements Expired card beside it read 1.
  statusCounts: { status: string; count: number }[]
  recent: DashboardRecord[]
  upcomingExpirations: UpcomingRecord[]
  recentlyExpiredRateSheets: UpcomingRecord[]
  // Every rate agreement on file, not only the ones near expiry. The expirations
  // card answers "what lapses soon"; this answers "what have I uploaded", which
  // is the question a customer asks before uploading their first invoice.
  rateAgreements: RateAgreement[]
  // Rate schedules whose contracted rates have already lapsed. Kept separate
  // from needsAttention because an expired rate sheet is a different problem
  // from a flagged invoice, and it drives its own card.
  expiredCount: number
  // Money extracted from the invoices we processed, summed per distinct
  // invoice rather than per row. Re-uploading one invoice under a different
  // filename writes another record, and summing rows counted one customer's
  // 5,312.31 invoice twice and their 1,606.32 invoice three times — 23,245.47
  // reported against 14,720.52 of actual invoices. Rate sheets carry no total,
  // so they contribute nothing. This is what was reviewed, NOT what was
  // recovered — it is the size of the pile, not the size of the finding.
  sumCharges: number
  // Distinct invoices carrying a readable total — one per invoice, not one per
  // upload. The field name predates that change.
  recordsWithCharges: number
  // What the contracted-rate audit found: the sum of positive overcharge_amount
  // across distinct invoices, so re-uploading an already-counted invoice does not
  // double the finding. This is money billed above the contracted rate, so it is a
  // real finding rather than a volume measure. Rate sheets contribute nothing,
  // and invoices the audit could not price contribute nothing either — an
  // unpriced invoice is not a zero overcharge.
  overchargeTotal: number
  overchargeCount: number
}

// Derived automatically from statuses with severity='critical' in data.tsx.
// No manual update needed — just set severity correctly per status there.
const ATTENTION_STATUSES = statuses
  .filter((s) => s.severity === 'critical')
  .map((s) => s.value.toLowerCase())

// 'expired:warning' is this product's rate-sheet expiry status (see data.tsx).
const EXPIRED_STATUS = 'expired:warning'

const UPCOMING_LIMIT = 10

interface RecordRow {
  id: string | number
  title: string | null
  status: string | null
  created_at: string
  due_date: string | null
  details: Record<string, unknown> | null
}

// A rate schedule's expiry is not the same thing as an invoice's payment due
// date. Rows processed after the processor fallback carry the expiry in
// `due_date`; rows written before it carry the expiry only inside `details`.
// Read both, otherwise the card matches nothing on the data we already have.
function expiryOf(row: RecordRow): string | null {
  const details: Record<string, unknown> = row.details ?? {}
  const raw =
    row.due_date ??
    (details.expiration_date as string | undefined) ??
    (details.rate_sheet_expiration_date as string | undefined)
  if (!raw) return null
  return String(raw).slice(0, 10)
}

function toDate(value: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

// A rate sheet expands to one record per lane, so collapse those back to a
// single entry per sheet — an expiring 6-lane sheet shows once, not six times.
function summariseRateSheets(
  rows: RecordRow[],
  keep: (expiry: Date) => boolean,
  ascending: boolean
): UpcomingRecord[] {
  const candidates: { row: RecordRow; expiry: Date; key: string }[] = []

  for (const row of rows) {
    const iso = expiryOf(row)
    const expiry = toDate(iso)
    if (!expiry || !keep(expiry)) continue
    candidates.push({ row, expiry, key: `${row.title}|${iso}` })
  }

  candidates.sort((a, b) =>
    ascending
      ? a.expiry.getTime() - b.expiry.getTime()
      : b.expiry.getTime() - a.expiry.getTime()
  )

  const seen = new Set<string>()
  const out: UpcomingRecord[] = []
  for (const { row, expiry, key } of candidates) {
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: String(row.id),
      title: row.title ?? 'Untitled rate schedule',
      status: row.status ?? 'unknown',
      due_date: expiry.toISOString(),
    })
    if (out.length === UPCOMING_LIMIT) break
  }
  return out
}

// An invoice is identified by its number scoped to the carrier that issued it —
// the same key the poller's duplicate detection uses. A row whose number could
// not be read gets its own key, so unreadable invoices are never merged together.
function invoiceKey(row: RecordRow): string {
  const number = String(row.details?.invoice_number ?? '').trim()
  if (!number) return `row:${row.id}`
  return `${row.title ?? ''}|${number}`
}

async function fetchDashboardStats(): Promise<DashboardStats> {
  const { data, error } = await supabase
    .from('records')
    .select('id, title, status, created_at, due_date, details')
    .eq('product_id', PRODUCT_ID)
    .order('created_at', { ascending: false })

  if (error) throw error

  const rows = (data ?? []) as RecordRow[]
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
  const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)

  const statusMap = new Map<string, number>()
  // Rate sheets counted so far, so a multi-lane sheet contributes one bar.
  const countedRateSheets = new Set<string>()
  let needsAttention = 0
  let addedThisWeek = 0
  let addedPrevWeek = 0
  let needsAttentionPrevWeek = 0
  let invoiceCount = 0
  let invoiceCountPrevWeek = 0

  for (const row of rows) {
    const status = row.status ?? 'unknown'
    // A rate sheet expands to one record per lane, so counting rows put the same
    // agreement in the chart once per lane. Invoices are not collapsed: each row
    // is a separate processing event, and re-uploads of one invoice can disagree
    // on status, so there is no single status to keep for the invoice.
    const isRateSheet =
      (row.details?.document_type as string | undefined) === 'rate_sheet'
    if (isRateSheet) {
      const sheetKey = `${row.title ?? ''}|${expiryOf(row) ?? ''}`
      if (!countedRateSheets.has(sheetKey)) {
        countedRateSheets.add(sheetKey)
        statusMap.set(status, (statusMap.get(status) ?? 0) + 1)
      }
    } else {
      statusMap.set(status, (statusMap.get(status) ?? 0) + 1)
    }
    const createdAt = new Date(row.created_at)
    const isAttention = ATTENTION_STATUSES.includes(status.toLowerCase())

    if (isAttention) needsAttention += 1
    const isInvoice =
      (row.details?.document_type as string | undefined) === 'invoice'
    if (isInvoice) {
      invoiceCount += 1
      // Same cut-off as totalPrevWeek below, so the trend compares like with like.
      if (createdAt < weekAgo) invoiceCountPrevWeek += 1
    }
    if (createdAt >= weekAgo) {
      addedThisWeek += 1
    } else if (createdAt >= twoWeeksAgo) {
      addedPrevWeek += 1
      if (isAttention) needsAttentionPrevWeek += 1
    }

    // Money is accumulated per distinct invoice after this loop, not per row —
    // see invoiceTotals below.
  }
  // Money is accumulated per distinct invoice rather than per row. Re-uploading
  // the same invoice under a different filename writes another record — the poller
  // only clears rows sharing a source_file_path — so summing rows counted one
  // customer's 5,312.31 invoice twice and their 1,606.32 invoice three times.
  const invoiceTotals = new Map<
    string,
    { charges: number | null; overcharge: number }
  >()
  for (const row of rows) {
    if ((row.details?.document_type as string | undefined) !== 'invoice') continue
    const key = invoiceKey(row)
    const totals = invoiceTotals.get(key) ?? { charges: null, overcharge: 0 }
    const charges = toNumber(row.details?.total_charges)
    // Highest figure wins when re-uploads disagree, and a missing total never
    // replaces a present one.
    if (charges !== null && (totals.charges === null || charges > totals.charges)) {
      totals.charges = charges
    }
    // Only positive figures. A negative overcharge_amount means the carrier billed
    // below the contracted rate, which is not an overcharge and would otherwise
    // net the headline finding down towards zero.
    const overcharge = toNumber(row.details?.overcharge_amount)
    if (overcharge !== null && overcharge > 0) {
      totals.overcharge = Math.max(totals.overcharge, overcharge)
    }
    invoiceTotals.set(key, totals)
  }

  let sumCharges = 0
  let recordsWithCharges = 0
  let overchargeTotal = 0
  let overchargeCount = 0
  for (const totals of invoiceTotals.values()) {
    if (totals.charges !== null) {
      sumCharges += totals.charges
      recordsWithCharges += 1
    }
    if (totals.overcharge > 0) {
      overchargeTotal += totals.overcharge
      overchargeCount += 1
    }
  }

  const totalPrevWeek = rows.filter((r) => new Date(r.created_at) < weekAgo).length

  // Rate schedules only: an invoice's due_date is a *payment* due date, so
  // listing both under one "Expirations" heading would mislead.
  const rateSheets = rows.filter(
    (r) => (r.details?.document_type as string | undefined) === 'rate_sheet'
  )

  // A rate sheet expands to one record per lane, so a 6-lane agreement is 6
  // rows. Grouping on title plus expiry collapses them to one entry and counts
  // the lanes. Expiry is part of the key because one carrier can hold two
  // sheets at different dates.
  const agreementMap = new Map<string, RateAgreement>()
  for (const row of rateSheets) {
    const title = row.title ?? 'Untitled rate agreement'
    const expiry = expiryOf(row)
    const key = `${title}|${expiry ?? ''}`
    const found = agreementMap.get(key)
    if (found) {
      found.laneCount += 1
      continue
    }
    agreementMap.set(key, {
      title,
      expiry,
      laneCount: 1,
      status: row.status ?? 'unknown',
    })
  }
  const rateAgreements = Array.from(agreementMap.values()).sort((a, b) =>
    a.title.localeCompare(b.title)
  )

  // Counted per agreement, not per row. A rate sheet expands to one record per
  // lane, so counting rows reported a single lapsed agreement covering six lanes
  // as six expired agreements.
  const expiredCount = rateAgreements.filter(
    (agreement) => agreement.status.toLowerCase() === EXPIRED_STATUS
  ).length

  const upcomingExpirations = summariseRateSheets(
    rateSheets,
    (expiry) => expiry >= now && expiry <= in90Days,
    true
  )

  // Nothing lapses in the next 90 days. Rather than render an empty card, show
  // the most recently lapsed schedules — still true, still worth knowing.
  const recentlyExpiredRateSheets =
    upcomingExpirations.length === 0
      ? summariseRateSheets(rateSheets, (expiry) => expiry < now, false)
      : []

  return {
    total: rows.length,
    invoiceCount,
    invoiceCountPrevWeek,
    needsAttention,
    addedThisWeek,
    addedPrevWeek,
    totalPrevWeek,
    needsAttentionPrevWeek,
    statusCounts: Array.from(statusMap.entries()).map(([status, count]) => ({
      status,
      count,
    })),
    recent: rows.slice(0, 5).map((row) => ({
      id: String(row.id),
      title: row.title ?? '',
      status: row.status ?? 'unknown',
      created_at: row.created_at,
    })),
    upcomingExpirations,
    recentlyExpiredRateSheets,
    rateAgreements,
    expiredCount,
    sumCharges,
    recordsWithCharges,
    overchargeTotal,
    overchargeCount,
  }
}

export function useDashboardStats() {
  return useQuery({
    queryKey: ['dashboard-stats', PRODUCT_ID],
    queryFn: fetchDashboardStats,
  })
}

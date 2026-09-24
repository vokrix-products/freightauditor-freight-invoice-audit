import { useQuery } from '@tanstack/react-query'
import { supabase, PRODUCT_ID } from '@/lib/supabase'
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

export interface DashboardStats {
  total: number
  needsAttention: number
  addedThisWeek: number
  addedPrevWeek: number
  totalPrevWeek: number
  needsAttentionPrevWeek: number
  statusCounts: { status: string; count: number }[]
  recent: DashboardRecord[]
  upcomingExpirations: UpcomingRecord[]
}

// Derived automatically from statuses with severity='critical' in data.tsx.
// No manual update needed — just set severity correctly per status there.
const ATTENTION_STATUSES = statuses
  .filter((s) => s.severity === 'critical')
  .map((s) => s.value.toLowerCase())

const UPCOMING_LIMIT = 10

async function fetchDashboardStats(): Promise<DashboardStats> {
  const { data, error } = await supabase
    .from('records')
    .select('id, title, status, created_at')
    .eq('product_id', PRODUCT_ID)
    .order('created_at', { ascending: false })

  if (error) throw error

  const rows = data ?? []
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)

  const statusMap = new Map<string, number>()
  let needsAttention = 0
  let addedThisWeek = 0
  let addedPrevWeek = 0
  let needsAttentionPrevWeek = 0

  for (const row of rows) {
    const status = row.status ?? 'unknown'
    statusMap.set(status, (statusMap.get(status) ?? 0) + 1)
    const createdAt = new Date(row.created_at)
    const isAttention = ATTENTION_STATUSES.includes(status.toLowerCase())

    if (isAttention) needsAttention += 1
    if (createdAt >= weekAgo) {
      addedThisWeek += 1
    } else if (createdAt >= twoWeeksAgo) {
      addedPrevWeek += 1
      if (isAttention) needsAttentionPrevWeek += 1
    }
  }
  const totalPrevWeek = rows.filter(r => new Date(r.created_at) < weekAgo).length

  // Fetch records with due_date in next 90 days, sorted soonest first.
  // Over-fetch: a rate sheet expands to one record per lane, so 10 raw rows can
  // be a single expiring sheet. Collapse in memory and trim to the real limit.
  const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString()
  const { data: upcomingData } = await supabase
    .from('records')
    .select('id, title, status, due_date, details')
    .eq('product_id', PRODUCT_ID)
    .not('due_date', 'is', null)
    .gte('due_date', now.toISOString())
    .lte('due_date', in90Days)
    .order('due_date', { ascending: true })
    .limit(UPCOMING_LIMIT * 5)

  const seenRateSheetKeys = new Set<string>()
  const upcomingExpirations: UpcomingRecord[] = []

  for (const row of upcomingData ?? []) {
    // Only rate sheets are collapsed. Two invoices from the same carrier due on
    // the same day are genuinely different records and must stay separate.
    const isRateSheet =
      (row.details as { document_type?: string } | null)?.document_type === 'rate_sheet'
    const key = isRateSheet
      ? `rate_sheet|${row.title}|${String(row.due_date).slice(0, 10)}`
      : `record|${String(row.id)}`

    if (seenRateSheetKeys.has(key)) continue
    seenRateSheetKeys.add(key)

    upcomingExpirations.push({
      id: String(row.id),
      title: row.title,
      status: row.status,
      due_date: row.due_date,
    })

    if (upcomingExpirations.length === UPCOMING_LIMIT) break
  }

  return {
    total: rows.length,
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
      title: row.title,
      status: row.status,
      created_at: row.created_at,
    })),
    upcomingExpirations,
  }
}

export function useDashboardStats() {
  return useQuery({
    queryKey: ['dashboard-stats', PRODUCT_ID],
    queryFn: fetchDashboardStats,
  })
}

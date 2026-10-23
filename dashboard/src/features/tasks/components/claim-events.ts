import { supabase, PRODUCT_ID } from '@/lib/supabase'

// The state of a claim after it leaves this product: was it filed with the
// carrier, and did the carrier credit or deny it. Without that, the second month
// of a subscription has no way to show that anything was ever recovered.
//
// There is no claim table, and adding one would mean a new table in a schema
// every other product shares. The append-only audit_log already carries exactly
// the right shape - (product_id, customer_id, action, entity, entity_id,
// metadata) - and its policies permit an authenticated insert while granting no
// update or delete, so a claim history cannot be rewritten after the fact.

export type ClaimState = 'generated' | 'filed' | 'credited' | 'denied'

// Only the states a person sets. 'generated' is written when the PDF is built
// and is not offered as a button.
export const CLAIM_STATES: Array<{ value: ClaimState; label: string }> = [
  { value: 'filed', label: 'Filed' },
  { value: 'credited', label: 'Credited' },
  { value: 'denied', label: 'Denied' },
]

export type ClaimEvent = {
  recordId: string
  state: ClaimState
  at: string
  amount: number | null
}

export async function logClaimEvent(
  recordId: string,
  state: ClaimState,
  amount: number | null
): Promise<boolean> {
  const { data } = await supabase.auth.getUser()
  const user = data.user
  if (!user) return false
  const { error } = await supabase.from('audit_log').insert({
    product_id: PRODUCT_ID,
    customer_id: user.id,
    action: `claim.${state}`,
    entity: 'record',
    entity_id: recordId,
    metadata: amount !== null ? { amount } : null,
  })
  return !error
}

// One pass over the log, newest first, keeping the first entry seen per record.
// The table is append-only, so the first row read is the current state.
export async function loadClaimEvents(): Promise<Map<string, ClaimEvent>> {
  const out = new Map<string, ClaimEvent>()
  const { data, error } = await supabase
    .from('audit_log')
    .select('entity_id, action, created_at, metadata')
    .eq('product_id', PRODUCT_ID)
    .eq('entity', 'record')
    .like('action', 'claim.%')
    .order('created_at', { ascending: false })

  if (error || !data) return out

  for (const row of data as Array<{
    entity_id: string | null
    action: string | null
    created_at: string | null
    metadata: unknown
  }>) {
    const id = String(row.entity_id ?? '')
    const action = String(row.action ?? '')
    if (!id || !action.startsWith('claim.') || out.has(id)) continue
    const meta =
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as { amount?: unknown })
        : {}
    out.set(id, {
      recordId: id,
      state: action.slice('claim.'.length) as ClaimState,
      at: String(row.created_at ?? ''),
      amount: typeof meta.amount === 'number' ? meta.amount : null,
    })
  }
  return out
}

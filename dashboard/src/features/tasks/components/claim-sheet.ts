import { formatCurrency, noteList, toNumber } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { type Task } from '../data/schema'

// A printable claim for one invoice. Every figure is read from what the audit
// already recorded - nothing is recalculated here, so the sheet cannot assert a
// number the audit did not find. The variance is `details.overcharge_amount`
// exactly as the poller wrote it.

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

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

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

// The money the customer was billed for the movement, in invoice order. Only
// the keys the poller actually wrote are rendered.
const CHARGE_ROWS: Array<[string, string]> = [
  ['freight_charge', 'Freight charge'],
  ['fuel_surcharge', 'Fuel surcharge'],
  ['accessorial_charges', 'Accessorial charges'],
  ['discount_amount', 'Discount'],
  ['total_charges', 'Total billed'],
]

export function claimableOvercharge(task: Task): number | null {
  const value = toNumber(asRecord(task.details).overcharge_amount)
  return value !== null && value > 0 ? value : null
}

function laneText(details: Record<string, unknown>): string {
  const origin = text(details.origin_location) || text(details.origin_zone_zip_postal)
  const destination =
    text(details.destination_location) || text(details.destination_zone_zip_postal)
  if (origin && destination) return `${origin} to ${destination}`
  return origin || destination
}

// The rate line an invoice was priced from names the agreement it came from,
// but the poller stores that name only on the rate sheet, not the invoice. So
// the agreement is read back from the sheet that carries it. Returns nothing
// when the match is absent - the sheet then says so rather than inventing one.
async function resolveContract(
  reference: string
): Promise<{ identifier?: string; basis?: string }> {
  if (!reference) return {}
  const { data, error } = await supabase
    .from('records')
    .select('details')
    .eq('details->>contract_rate_sheet_identifier', reference)
    .limit(1)
  if (error || !data || data.length === 0) return {}
  const details = asRecord((data[0] as { details: unknown }).details)
  return {
    identifier: text(details.contract_rate_sheet_identifier) || undefined,
    basis: text(details.rate_basis) || undefined,
  }
}

// The party filing the claim. Collected at signup and stored on the account,
// because the shipper's own legal entity appears on no document the poller
// reads - only the carrier is named on the invoice.
async function claimantName(): Promise<string> {
  const { data } = await supabase.auth.getUser()
  const company = data.user?.user_metadata?.company
  return typeof company === 'string' ? company.trim() : ''
}

export async function openClaimSheet(task: Task): Promise<void> {
  const details = asRecord(task.details)
  const notes = noteList(details._notes)
  const overcharge = claimableOvercharge(task)

  // The popup must be opened on the click itself, before any await, or the
  // browser blocks it. A document opened this way can be written to later.
  const win = window.open('', '_blank')
  if (!win) return

  const contractInfo = await resolveContract(text(details.matched_rate_line_reference))
  const claimant = await claimantName()

  const identity: Array<[string, string]> = [
    ['Carrier', text(task.title)],
    ['Invoice number', text(details.invoice_number)],
    ['BOL / PRO number', text(details.bill_of_lading_pro_number)],
    ['Ship date', text(details.ship_date)],
    ['Lane', laneText(details)],
    ['Rate basis', text(details.rate_basis) || contractInfo.basis || ''],
  ]

  const contract: Array<[string, string]> = [
    ['Contracted rate line', text(details.matched_rate_line_reference)],
    ['Rate agreement', text(details.contract_rate_sheet_identifier) || contractInfo.identifier || ''],
  ]

  const charges = CHARGE_ROWS.map(([key, label]) => {
    const formatted = formatCurrency(details[key])
    return formatted ? ([label, formatted] as [string, string]) : null
  }).filter((row): row is [string, string] => row !== null)

  const row = ([label, value]: [string, string]) =>
    value
      ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`
      : ''

  const findings = notes.length
    ? notes.map((note) => `<li>${esc(note)}</li>`).join('')
    : '<li>No exception was recorded against the contracted rate.</li>'

  const variance = overcharge !== null ? formatCurrency(overcharge) : null
  const generated = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(text(details.invoice_number) || text(task.title) || 'Claim')} - overbilling claim</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 0; padding: 40px; }
  .sheet { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #555; font-size: 13px; margin: 0 0 28px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #555; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 400; color: #555; width: 45%; padding: 5px 0; vertical-align: top; }
  td { padding: 5px 0; font-weight: 500; word-break: break-word; }
  .variance { margin-top: 28px; padding: 16px; border: 1px solid #b91c1c; background: #fef2f2; }
  .variance .label { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #7f1d1d; }
  .variance .amount { font-size: 26px; font-weight: 700; color: #b91c1c; margin-top: 2px; }
  ul { margin: 0; padding-left: 18px; }
  li { margin-bottom: 6px; }
  footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid #ddd; color: #666; font-size: 12px; }
  @media print { body { padding: 0; } .sheet { max-width: none; } }
</style>
</head>
<body>
<div class="sheet">
  <h1>Freight invoice overbilling claim</h1>
  <p class="sub">Billed charges compared against the contracted rate agreement on file.</p>

  <h2>Claimant</h2>
  <table><tbody>${row(['Account', claimant || 'Not provided'])}</tbody></table>

  <h2>Invoice</h2>
  <table><tbody>${identity.map(row).join('')}</tbody></table>

  <h2>Billed charges</h2>
  <table><tbody>${charges.map(row).join('') || '<tr><td>No charge breakdown was extracted from this document.</td></tr>'}</tbody></table>

  <h2>Contracted rate</h2>
  <table><tbody>${contract.map(row).join('') || '<tr><td>No contracted rate was matched to this shipment.</td></tr>'}</tbody></table>

  <h2>Findings</h2>
  <ul>${findings}</ul>

  ${
    variance
      ? `<div class="variance"><div class="label">Amount billed above the contracted rate</div><div class="amount">${esc(variance)}</div></div>`
      : ''
  }

  <footer>
    Prepared ${esc(generated)} from the invoice and rate agreement on file.
    Figures are reproduced from the audit as recorded; no charge has been recalculated.
  </footer>
</div>
<script>window.addEventListener('load', function () { window.print() })</script>
</body>
</html>`

  win.document.write(html)
  win.document.close()
}

import { formatCurrency, noteList, toNumber } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { type Task } from '../data/schema'
import { glAccountFor } from './gl-hints'

// A printable claim for one invoice. Every figure is read from what the audit
// already recorded - nothing is recalculated here, so the sheet cannot assert a
// number the audit did not find. The variance is `details.overcharge_amount`
// exactly as the poller wrote it.
//
// The document is drawn with pdf-lib rather than printed from markup: a carrier
// receiving a claim expects a file, and a browser print dialog produces one only
// if the person printing chooses the right paper size and margins.

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
async function claimantIdentity(): Promise<{ company: string; uid: string }> {
  const { data } = await supabase.auth.getUser()
  const user = data.user
  const company = user?.user_metadata?.company
  return {
    uid: user?.id ?? '',
    company: typeof company === 'string' ? company.trim() : '',
  }
}

// The results bucket policy already scopes folder[1] to auth.uid(), so writing
// under the customer's own folder needs no new bucket or policy. The filename
// leads with a fixed-width timestamp, so name-ordered listing is newest first.
function claimPath(uid: string, taskId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${uid}/claims/${taskId}-${stamp}.pdf`
}

function fileName(task: Task, invoiceNumber: string): string {
  const stem = (invoiceNumber || task.id).replace(/[^A-Za-z0-9._-]+/g, '-')
  return `${stem}-claim.pdf`
}

type ClaimSheet = {
  claimant: string
  invoiceNumber: string
  identity: Array<[string, string]>
  charges: Array<[string, string, string]>
  contract: Array<[string, string]>
  notes: string[]
  variance: string | null
  generated: string
}

// The standard PDF fonts are WinAnsi and throw on a glyph outside it, so
// anything a rate sheet might contain is folded down to plain ASCII first.
function safe(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\n]/g, '')
}

const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 54
const CONTENT_W = PAGE_W - MARGIN * 2
const GREY = [0.35, 0.35, 0.35] as const
const INK = [0.07, 0.07, 0.07] as const
const RED = [0.72, 0.11, 0.11] as const

async function renderClaimPdf(sheet: ClaimSheet): Promise<Uint8Array> {
  // Imported here rather than at the top of the file so the module is only
  // fetched when somebody actually asks for a claim, not on first paint.
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  let page = doc.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN

  const ensure = (space: number) => {
    if (y - space < MARGIN + 30) {
      page = doc.addPage([PAGE_W, PAGE_H])
      y = PAGE_H - MARGIN
    }
  }

  // A single word wider than the column is broken across lines rather than
  // allowed to run past the margin.
  const splitWord = (word: string, size: number, maxWidth: number) => {
    const parts: string[] = []
    let current = ''
    for (const ch of word) {
      const next = current + ch
      if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
        parts.push(current)
        current = ch
      } else {
        current = next
      }
    }
    if (current) parts.push(current)
    return parts
  }

  const wrap = (value: string, size: number, maxWidth: number) => {
    const out: string[] = []
    for (const para of safe(value).split('\n')) {
      const words = para.split(/\s+/).filter(Boolean)
      if (!words.length) {
        out.push('')
        continue
      }
      let line = ''
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
          line = candidate
          continue
        }
        if (line) out.push(line)
        if (font.widthOfTextAtSize(word, size) > maxWidth) {
          const parts = splitWord(word, size, maxWidth)
          out.push(...parts.slice(0, -1))
          line = parts[parts.length - 1] ?? ''
        } else {
          line = word
        }
      }
      if (line) out.push(line)
    }
    return out.length ? out : ['']
  }

  const section = (title: string) => {
    ensure(34)
    y -= 16
    page.drawText(safe(title).toUpperCase(), {
      x: MARGIN,
      y: y - 8,
      size: 8.5,
      font: bold,
      color: rgb(...GREY),
    })
    y -= 13
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.85),
    })
    y -= 8
  }

  const rows = (entries: Array<[string, string]>) => {
    const visible = entries.filter(([, value]) => value)
    if (!visible.length) return
    const labelWidth = CONTENT_W * 0.42
    const valueWidth = CONTENT_W * 0.56
    for (const [label, value] of visible) {
      const labelLines = wrap(label, 9.5, labelWidth)
      const valueLines = wrap(value, 9.5, valueWidth)
      const count = Math.max(labelLines.length, valueLines.length)
      ensure(count * 13 + 6)
      const top = y
      labelLines.forEach((line, i) => {
        page.drawText(line, {
          x: MARGIN,
          y: top - 9.5 - i * 13,
          size: 9.5,
          font,
          color: rgb(...GREY),
        })
      })
      valueLines.forEach((line, i) => {
        page.drawText(line, {
          x: MARGIN + CONTENT_W * 0.45,
          y: top - 9.5 - i * 13,
          size: 9.5,
          font: bold,
          color: rgb(...INK),
        })
      })
      y = top - count * 13 - 3
    }
  }

  // Charge, amount, and the account it usually lands in. Three columns rather
  // than a sentence, because the reader is going to key this into a ledger. The
  // account names come from gl-hints and are printed as suggestions, never as
  // codes - a chart of accounts is per-company and this sheet is not the place
  // to invent one.
  const chargeRows = (entries: Array<[string, string, string]>) => {
    const colLabel = MARGIN
    const colAmount = MARGIN + CONTENT_W * 0.46
    const colAccount = MARGIN + CONTENT_W * 0.66
    const labelWidth = CONTENT_W * 0.44
    const accountWidth = CONTENT_W * 0.34

    ensure(28)
    page.drawText('CHARGE', {
      x: colLabel,
      y: y - 7,
      size: 7,
      font: bold,
      color: rgb(...GREY),
    })
    page.drawText('BILLED', {
      x: colAmount,
      y: y - 7,
      size: 7,
      font: bold,
      color: rgb(...GREY),
    })
    page.drawText('SUGGESTED ACCOUNT', {
      x: colAccount,
      y: y - 7,
      size: 7,
      font: bold,
      color: rgb(...GREY),
    })
    y -= 12

    for (const [label, amount, account] of entries) {
      const labelLines = wrap(label, 9.5, labelWidth)
      const accountLines = account ? wrap(account, 8.5, accountWidth) : []
      const count = Math.max(labelLines.length, accountLines.length, 1)
      ensure(count * 13 + 4)
      const top = y
      labelLines.forEach((line, i) => {
        page.drawText(line, {
          x: colLabel,
          y: top - 9.5 - i * 13,
          size: 9.5,
          font,
          color: rgb(...INK),
        })
      })
      page.drawText(safe(amount), {
        x: colAmount,
        y: top - 9.5,
        size: 9.5,
        font: bold,
        color: rgb(...INK),
      })
      accountLines.forEach((line, i) => {
        page.drawText(line, {
          x: colAccount,
          y: top - 9.5 - i * 13,
          size: 8.5,
          font,
          color: rgb(...GREY),
        })
      })
      y = top - count * 13 - 2
    }
  }

  // Pitch
  page.drawText('Freight invoice overbilling claim', {
    x: MARGIN,
    y: y - 18,
    size: 18,
    font: bold,
    color: rgb(...INK),
  })
  y -= 26
  const pitch = wrap(
    'Billed charges compared against the contracted rate agreement on file.',
    10,
    CONTENT_W
  )
  for (const line of pitch) {
    page.drawText(line, { x: MARGIN, y: y - 10, size: 10, font, color: rgb(...GREY) })
    y -= 13
  }

  section('Claimant')
  rows([['Company', sheet.claimant || 'Not provided']])

  section('Invoice')
  rows(sheet.identity)

  section('Billed charges')
  if (sheet.charges.length) {
    chargeRows(sheet.charges)
    // Says out loud what the column is and is not, so nobody posts to it blind.
    ensure(26)
    y -= 4
    for (const line of wrap(
      'Account names are a starting point for your own chart of accounts, not a posting instruction.',
      8,
      CONTENT_W
    )) {
      page.drawText(line, { x: MARGIN, y: y - 8, size: 8, font, color: rgb(...GREY) })
      y -= 11
    }
  } else {
    const lines = wrap(
      'No charge breakdown was extracted from this document.',
      9.5,
      CONTENT_W
    )
    ensure(lines.length * 13)
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: MARGIN,
        y: y - 9.5 - i * 13,
        size: 9.5,
        font,
        color: rgb(...GREY),
      })
    })
    y -= lines.length * 13
  }

  section('Contracted rate')
  if (sheet.contract.some(([, value]) => value)) {
    rows(sheet.contract)
  } else {
    const lines = wrap('No contracted rate was matched to this shipment.', 9.5, CONTENT_W)
    ensure(lines.length * 13)
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: MARGIN,
        y: y - 9.5 - i * 13,
        size: 9.5,
        font,
        color: rgb(...GREY),
      })
    })
    y -= lines.length * 13
  }

  section('Findings')
  const notes = sheet.notes.length
    ? sheet.notes
    : ['No exception was recorded against the contracted rate.']
  for (const note of notes) {
    const lines = wrap(note, 9.5, CONTENT_W - 16)
    ensure(lines.length * 13 + 6)
    page.drawText('-', {
      x: MARGIN,
      y: y - 9.5,
      size: 9.5,
      font,
      color: rgb(...GREY),
    })
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: MARGIN + 16,
        y: y - 9.5 - i * 13,
        size: 9.5,
        font,
        color: rgb(...INK),
      })
    })
    y -= lines.length * 13 + 4
  }

  if (sheet.variance) {
    const boxHeight = 58
    ensure(boxHeight + 20)
    y -= 12
    page.drawRectangle({
      x: MARGIN,
      y: y - boxHeight,
      width: CONTENT_W,
      height: boxHeight,
      color: rgb(0.996, 0.949, 0.949),
      borderColor: rgb(...RED),
      borderWidth: 1,
    })
    page.drawText('AMOUNT BILLED ABOVE THE CONTRACTED RATE', {
      x: MARGIN + 14,
      y: y - 22,
      size: 7.5,
      font: bold,
      color: rgb(...RED),
    })
    page.drawText(safe(sheet.variance), {
      x: MARGIN + 14,
      y: y - 46,
      size: 20,
      font: bold,
      color: rgb(...RED),
    })
    y -= boxHeight + 12
  }

  ensure(50)
  y -= 10
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.85, 0.85, 0.85),
  })
  y -= 14
  const footer = wrap(
    `Prepared ${sheet.generated} from the invoice and rate agreement on file. ` +
      'Figures are reproduced from the audit as recorded; no charge has been recalculated.',
    8,
    CONTENT_W
  )
  for (const line of footer) {
    page.drawText(line, { x: MARGIN, y: y - 8, size: 8, font, color: rgb(...GREY) })
    y -= 11
  }

  doc.setTitle(
    safe(sheet.invoiceNumber ? `${sheet.invoiceNumber} - overbilling claim` : 'Overbilling claim')
  )
  doc.setSubject('Freight invoice overbilling claim')
  doc.setProducer('FreightAuditor')
  doc.setCreator('FreightAuditor')

  return doc.save()
}

export async function openClaimSheet(task: Task): Promise<void> {
  const details = asRecord(task.details)
  const notes = noteList(details._notes)
  const overcharge = claimableOvercharge(task)

  // The window is opened on the click itself, before any await, or the browser
  // blocks it. It is pointed at the finished file once the PDF exists.
  const placeholder = window.open('', '_blank')

  const contractInfo = await resolveContract(text(details.matched_rate_line_reference))
  const { company: claimant, uid } = await claimantIdentity()

  const sheet: ClaimSheet = {
    claimant,
    invoiceNumber: text(details.invoice_number),
    identity: [
      ['Carrier', text(task.title)],
      ['Invoice number', text(details.invoice_number)],
      ['BOL / PRO number', text(details.bill_of_lading_pro_number)],
      ['Ship date', text(details.ship_date)],
      ['Lane', laneText(details)],
      ['Rate basis', text(details.rate_basis) || contractInfo.basis || ''],
    ],
    charges: CHARGE_ROWS.map(([key, label]) => {
      const formatted = formatCurrency(details[key])
      return formatted
        ? ([label, formatted, glAccountFor(key)] as [string, string, string])
        : null
    }).filter((row): row is [string, string, string] => row !== null),
    contract: [
      ['Contracted rate line', text(details.matched_rate_line_reference)],
      [
        'Rate agreement',
        text(details.contract_rate_sheet_identifier) || contractInfo.identifier || '',
      ],
    ],
    notes,
    variance: overcharge !== null ? formatCurrency(overcharge) : null,
    generated: new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
  }

  const bytes = await renderClaimPdf(sheet)
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const name = fileName(task, sheet.invoiceNumber)

  if (placeholder) {
    placeholder.location.href = url
  } else {
    // Popup blocked - hand the person the file instead of failing silently.
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
  }

  window.setTimeout(() => URL.revokeObjectURL(url), 300_000)

  if (!uid) return
  const { error: saveError } = await supabase.storage
    .from('results')
    .upload(claimPath(uid, task.id), blob, {
      contentType: 'application/pdf',
      upsert: false,
    })
  toast(
    saveError
      ? 'Claim created, but the saved copy could not be stored.'
      : 'A copy of this claim was saved to your results folder.'
  )
}

// Opens the newest saved claim for a record. The popup is opened on the click,
// before any await, or the browser blocks it.
export async function openSavedClaim(task: Task): Promise<void> {
  const win = window.open('', '_blank')
  if (!win) return
  const { uid } = await claimantIdentity()
  if (!uid) {
    win.close()
    return
  }
  const { data: files, error } = await supabase.storage
    .from('results')
    .list(`${uid}/claims`, { limit: 100, sortBy: { column: 'name', order: 'desc' } })
  const saved = error ? undefined : files?.find((f) => f.name.startsWith(`${task.id}-`))
  if (!saved) {
    win.close()
    toast('No saved claim for this record yet.')
    return
  }
  const { data: signed } = await supabase.storage
    .from('results')
    .createSignedUrl(`${uid}/claims/${saved.name}`, 600)
  if (!signed?.signedUrl) {
    win.close()
    return
  }
  win.location.href = signed.signedUrl
}

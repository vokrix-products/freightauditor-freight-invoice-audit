// Formatting helpers shared by the dashboard cards and the records table.
//
// Extracted values arrive from the poller as `unknown`: they may be numbers,
// strings like "$1,467.64", or absent entirely. Every read goes through
// toNumber() rather than trusting the shape.

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

// Parses a value that may be a number or a formatted currency string.
// Returns null when there is no usable number, so callers can tell
// "no value" apart from a real zero.
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[^0-9.-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.') {
    return null
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

export function formatCurrency(value: unknown): string | null {
  const parsed = toNumber(value)
  return parsed === null ? null : usd.format(parsed)
}

// The poller writes human-readable explanations to details._notes as an array
// (e.g. "rate sheet expired"). Returns every one of them, in the order written,
// so a row can show the first and a drill-down can show them all.
export function noteList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? [] : [trimmed]
  }
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim() !== ''
    )
    .map((entry) => entry.trim())
}

// The first note, so a flagged row explains itself without opening anything.
export function firstNote(value: unknown): string | null {
  return noteList(value)[0] ?? null
}

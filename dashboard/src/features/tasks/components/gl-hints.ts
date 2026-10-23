// Charge key -> the account a controller most often posts it to.
//
// Names rather than numbers, deliberately. A chart of accounts is per-company,
// so a numeric code invented here would be a posting instruction printed on a
// claim that the customer never approved. Replace a name with a real code below
// and both the claim sheet and the CSV export follow.
export const GL_ACCOUNTS: Record<string, string> = {
  freight_charge: 'Freight expense',
  fuel_surcharge: 'Fuel surcharge',
  accessorial_charges: 'Accessorial expense',
  discount_amount: 'Freight discount (contra)',
}

export function glAccountFor(key: string): string {
  return GL_ACCOUNTS[key] ?? ''
}

// The accounts a record's own charge breakdown points at, in a fixed order so
// two exports of the same row agree.
export function glHintsForDetails(details: unknown): string[] {
  const record =
    details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {}
  return Object.keys(GL_ACCOUNTS)
    .filter((key) => {
      const value = record[key]
      if (value === null || value === undefined) return false
      return String(value).trim() !== ''
    })
    .map((key) => GL_ACCOUNTS[key])
}

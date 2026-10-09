import '@tanstack/react-table'

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    className?: string // apply to both th and td
    tdClassName?: string
    thClassName?: string
    // The heading as a plain string. Anything that cannot render a React node
    // reads this - the CSV export writes its header row from it - and falls
    // back to the raw column id where a column has not set one.
    title?: string
  }
}

import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { statuses, severityToBadgeVariant } from '@/features/tasks/data/data'
import { useDashboardStats } from '../data/dashboard'

function formatExpiry(iso: string | null): string {
  if (!iso) return 'no expiry on file'
  return 'expires ' + new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function RateAgreements() {
  const { data, isLoading } = useDashboardStats()

  if (isLoading) {
    return (
      <div className='space-y-2'>
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className='flex items-center justify-between rounded-md border px-3 py-2'
          >
            <Skeleton className='h-3 w-40' />
            <Skeleton className='h-6 w-16 rounded-full' />
          </div>
        ))}
      </div>
    )
  }

  const agreements = data?.rateAgreements ?? []

  if (agreements.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center py-10 text-center'>
        <p className='max-w-sm text-sm text-muted-foreground'>
          No rate agreements on file yet. Upload an agreement before its
          invoices so those invoices can be audited against the contracted
          rates.
        </p>
      </div>
    )
  }

  return (
    <div className='space-y-2'>
      <p className='text-xs text-muted-foreground'>
        Invoices for these carriers are audited against the rates on file.
      </p>
      {agreements.map((agreement) => {
        const statusDef = statuses.find((s) => s.value === agreement.status)
        const severity = statusDef?.severity ?? 'neutral'
        return (
          <div
            key={`${agreement.title}|${agreement.expiry ?? ''}`}
            className='flex items-center justify-between rounded-md border px-3 py-2'
          >
            <div className='flex min-w-0 flex-col'>
              <span className='truncate text-sm font-medium'>
                {agreement.title}
              </span>
              <span className='text-xs text-muted-foreground'>
                {agreement.laneCount === 1
                  ? '1 lane'
                  : `${agreement.laneCount} lanes`}{' '}
                · {formatExpiry(agreement.expiry)}
              </span>
            </div>
            <Badge
              variant={severityToBadgeVariant[severity]}
              className='ml-2 shrink-0'
            >
              {statusDef?.label ?? agreement.status}
            </Badge>
          </div>
        )
      })}
    </div>
  )
}

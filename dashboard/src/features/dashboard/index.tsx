import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { JobsCard } from '@/features/jobs/components/jobs-card'
import { NotificationsBell } from '@/components/notifications-bell'
import { PRODUCT_ARCHETYPE, RECORDS_LABEL } from '@/product-config'
import { formatCurrency } from '@/lib/format'
import { ReportCard } from './components/report-card'
import { Overview } from './components/overview'
import { RecentActivity } from './components/recent-activity'
import { RateAgreements } from './components/rate-agreements'
import { UpcomingExpirations } from './components/upcoming-expirations'
import { useDashboardStats } from './data/dashboard'
import { supabase } from '@/lib/supabase'
import { Skeleton } from '@/components/ui/skeleton'
import { NumberTicker } from '@/components/magicui/number-ticker'
import {
  ProductTourProvider,
  TourTrigger,
} from '@/components/tour/product-tour'
import { useAuthStore } from '@/stores/auth-store'

function Trend({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) return null
  const diff = current - previous
  const pct = previous === 0 ? 100 : Math.round(Math.abs(diff / previous) * 100)
  if (diff === 0) return <span className='text-xs text-muted-foreground'>No change</span>
  return (
    <span className={diff > 0 ? 'text-xs text-success' : 'text-xs text-destructive'}>
      {diff > 0 ? '↑' : '↓'} {pct}% vs last week
    </span>
  )
}

// PRODUCT_CUSTOMIZE: these five cards are written for a document-audit
// product — volume, what needs a human, what the audit found in money, what
// has lapsed, and the money reviewed. Retitle to match the domain if the
// product tracks something else.
export function Dashboard() {
  const { data, isLoading } = useDashboardStats()
  const [showUpgradeBanner, setShowUpgradeBanner] = useState(false)
  // Remembered per person, so the walkthrough does not greet a returning user
  // as if they had never seen the page.
  const authUser = useAuthStore((state) => state.auth.user)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('upgraded') === 'true') {
      window.history.replaceState({}, '', window.location.pathname)
      setTimeout(() => setShowUpgradeBanner(true), 0)
    }
  }, [])

  async function handleRefreshSession() {
    await supabase.auth.refreshSession()
    window.location.reload()
  }

  const chargesLabel = data ? formatCurrency(data.sumCharges) : null
  const chargedRecords = data?.recordsWithCharges ?? 0
  const overchargeLabel = data ? formatCurrency(data.overchargeTotal) : null
  const overchargeRecords = data?.overchargeCount ?? 0

  return (
    <>
      {/* ===== Top Heading ===== */}
      <Header>
        <Search />
        <ThemeSwitch />
        <NotificationsBell />
        <ProfileDropdown />
      </Header>

      {/* ===== Main ===== */}
      <Main>
        {showUpgradeBanner && (
          <div className='flex items-center justify-between rounded-lg border border-success bg-success/10 px-4 py-3 text-sm text-success mb-4'>
            <span>Payment successful! Refresh your session to activate full access.</span>
            <button
              onClick={handleRefreshSession}
              className='ml-4 font-medium underline underline-offset-2 hover:no-underline'
            >
              Refresh now
            </button>
          </div>
        )}
        <div className='mb-2 flex items-center justify-between space-y-2'>
          <h1 data-tour='welcome' className='text-2xl font-bold tracking-tight'>
            Dashboard
          </h1>
          <ProductTourProvider
            storageKey={authUser ? `tour:freightauditor:${authUser.email}` : null}
          >
            <TourTrigger />
          </ProductTourProvider>
        </div>
        <div className='space-y-4'>
          {/* Wrapped so the walkthrough can point at the upload area without
              changing anything JobsCard renders. */}
          <div data-tour='upload'>
            <JobsCard />
          </div>
          {PRODUCT_ARCHETYPE === 'report' && <ReportCard />}
          <div data-tour='stats' className='grid gap-4 sm:grid-cols-2 lg:grid-cols-5'>
            <Link
              to='/tasks'
              search={{ document_type: ['Invoice'] }}
              className='block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>{RECORDS_LABEL}</CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className='h-8 w-16' />
                ) : (
                  <>
                    <div className='text-2xl font-bold tracking-tight'>
                      <NumberTicker value={data?.invoiceCount ?? 0} />
                    </div>
                    <Trend
                      current={data?.invoiceCount ?? 0}
                      previous={data?.invoiceCountPrevWeek ?? 0}
                    />
                  </>
                )}
              </CardContent>
            </Card>
            </Link>
            <Link
              to='/tasks'
              search={{ status: ['flagged:critical', 'missing:critical'] }}
              className='block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>Flagged for Review</CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className='h-8 w-16' />
                ) : (
                  <>
                    <div className='text-2xl font-bold tracking-tight text-destructive'>
                      <NumberTicker value={data?.needsAttention ?? 0} />
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      Errors or overbilling detected
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
            </Link>
            <Link
              to='/tasks'
              search={{ status: ['flagged:critical'] }}
              className='block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>Overcharges Found</CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className='h-8 w-24' />
                ) : (
                  <>
                    <div className='text-2xl font-bold tracking-tight text-destructive'>
                      {overchargeLabel ?? '—'}
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      {overchargeRecords === 1
                        ? 'billed above the contracted rate on 1 invoice'
                        : `billed above the contracted rate on ${overchargeRecords} invoices`}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
            </Link>
            <Link
              to='/tasks'
              search={{ status: ['expired:warning'] }}
              className='block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>Rate Agreements Expired</CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className='h-8 w-16' />
                ) : (
                  <>
                    <div className='text-2xl font-bold tracking-tight text-warning'>
                      <NumberTicker value={data?.expiredCount ?? 0} />
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      Audits run against stale rates
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
            </Link>
            <Link
              to='/tasks'
              search={{ document_type: ['Invoice'] }}
              className='block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>Charges Reviewed</CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className='h-8 w-24' />
                ) : (
                  <>
                    <div className='text-2xl font-bold tracking-tight'>
                      {chargesLabel ?? '—'}
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      {chargedRecords === 1
                        ? 'across 1 invoice'
                        : `across ${chargedRecords} invoices`}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
            </Link>
          </div>
          <div className='grid grid-cols-1 gap-4 lg:grid-cols-7'>
            <Card data-tour='breakdown' className='col-span-1 lg:col-span-4'>
              <CardHeader>
                <CardTitle>Status Breakdown</CardTitle>
              </CardHeader>
              <CardContent className='ps-2'>
                <Overview />
              </CardContent>
            </Card>
            <Card data-tour='activity' className='col-span-1 lg:col-span-3'>
              <CardHeader>
                <CardTitle>Recent Activity</CardTitle>
                <CardDescription>Latest records added</CardDescription>
              </CardHeader>
              <CardContent>
                <RecentActivity />
              </CardContent>
            </Card>
          </div>
          {/* PRODUCT_CUSTOMIZE: this card only suits products whose records carry
              an expiry/renewal/deadline. Here it is scoped to rate schedules —
              an invoice's due_date is a payment due date, not an expiry — and
              falls back to recently lapsed schedules so it is never empty on a
              dataset whose sheets are all in the past. Remove the card for
              products that have no such dates. */}
          <Card>
            <CardHeader>
              <CardTitle>Rate Agreements Expiring</CardTitle>
              <CardDescription>Carrier rate schedules expiring soon — or already lapsed</CardDescription>
            </CardHeader>
            <CardContent>
              <UpcomingExpirations />
            </CardContent>
          </Card>
          {/* What is on file, as opposed to what lapses soon. One entry per
              agreement rather than one per lane, so a 6-lane sheet shows once. */}
          <Card data-tour='agreements'>
            <CardHeader>
              <CardTitle>Rate Agreements on File</CardTitle>
              <CardDescription>
                Carrier rate agreements uploaded so far, and the lanes each covers
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RateAgreements />
            </CardContent>
          </Card>
        </div>
      </Main>
    </>
  )
}

import { useEffect, useState } from 'react'
import { ExternalLink, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { statuses, severityToBadgeVariant } from '../data/data'
import { type Task } from '../data/schema'
import {
  claimableOvercharge,
  openClaimSheet,
  openSavedClaim,
} from './claim-sheet'
import {
  CLAIM_STATES,
  loadClaimEvents,
  logClaimEvent,
  type ClaimState,
} from './claim-events'
import { openSourceFile } from './open-source-file'
import { RecordFindings } from './record-findings'

type TasksViewSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow: Task | null
}

// Read-only. Clicking a row used to open the editable form, which invited a
// customer to rewrite the poller's own output. This shows what the audit found.
export function TasksViewSheet({
  open,
  onOpenChange,
  currentRow,
}: TasksViewSheetProps) {
  const [claimState, setClaimState] = useState<ClaimState | null>(null)

  // Declared before the null guard on purpose: closing the sheet sets
  // currentRow to null, and a hook placed after an early return would change
  // the hook order between renders.
  useEffect(() => {
    if (!currentRow) return
    const id = currentRow.id
    let alive = true
    void loadClaimEvents().then((events) => {
      if (alive) setClaimState(events.get(id)?.state ?? null)
    })
    return () => {
      alive = false
    }
  }, [currentRow])

  if (!currentRow) return null

  const row = currentRow
  const statusDef = statuses.find((s) => s.value === row.status)
  const severity = statusDef?.severity ?? 'neutral'
  const sourcePath = row.source_file_path

  // Only offered where there is money to claim. A document with no variance has
  // nothing to demand back, and a sheet saying so would be noise.
  const hasClaim = claimableOvercharge(row) !== null

  async function recordClaim(state: ClaimState) {
    const ok = await logClaimEvent(row.id, state, claimableOvercharge(row))
    if (!ok) {
      toast.error('Could not record that. Try again.')
      return
    }
    setClaimState(state)
    toast.success(`Claim marked ${state}.`)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='flex flex-col overflow-y-auto'>
        <SheetHeader className='text-start'>
          <SheetTitle>{row.title}</SheetTitle>
          <SheetDescription>
            What the audit found on this document.
          </SheetDescription>
        </SheetHeader>
        <div className='space-y-3 px-4 pb-6'>
          <div className='flex flex-wrap items-center gap-2'>
            <Badge variant={severityToBadgeVariant[severity]}>
              {statusDef?.label ?? row.status}
            </Badge>
            {hasClaim && (
              <Button
                variant='default'
                size='sm'
                className='h-6 px-2 text-xs'
                onClick={() => void openClaimSheet(row)}
              >
                <FileText className='mr-1 size-3' />
                Claim sheet
              </Button>
            )}
            {hasClaim && (
              <Button
                variant='ghost'
                size='sm'
                className='h-6 px-2 text-xs'
                onClick={() => void openSavedClaim(row)}
              >
                <ExternalLink className='mr-1 size-3' />
                Saved claim
              </Button>
            )}
            {sourcePath && (
              <Button
                variant='ghost'
                size='sm'
                className='h-6 px-2 text-xs'
                onClick={() => void openSourceFile(sourcePath)}
              >
                <ExternalLink className='mr-1 size-3' />
                Original file
              </Button>
            )}
          </div>
          {hasClaim && (
            <div className='flex flex-wrap items-center gap-2'>
              <span className='text-xs text-muted-foreground'>
                Record what happened to this claim:
              </span>
              {CLAIM_STATES.map(({ value, label }) => (
                <Button
                  key={value}
                  variant='outline'
                  size='sm'
                  className='h-6 px-2 text-xs'
                  disabled={claimState === value}
                  onClick={() => void recordClaim(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
          {claimState && (
            <p className='text-xs text-muted-foreground'>
              This record is marked <strong>{claimState}</strong>.
            </p>
          )}
          <RecordFindings task={row} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

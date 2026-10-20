import { ExternalLink, FileText } from 'lucide-react'
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
  if (!currentRow) return null

  const statusDef = statuses.find((s) => s.value === currentRow.status)
  const severity = statusDef?.severity ?? 'neutral'
  const sourcePath = currentRow.source_file_path

  // Only offered where there is money to claim. A document with no variance has
  // nothing to demand back, and a sheet saying so would be noise.
  const hasClaim = claimableOvercharge(currentRow) !== null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='flex flex-col overflow-y-auto'>
        <SheetHeader className='text-start'>
          <SheetTitle>{currentRow.title}</SheetTitle>
          <SheetDescription>
            What the audit found on this document.
          </SheetDescription>
        </SheetHeader>
        <div className='space-y-3 px-4 pb-6'>
          <div className='flex flex-wrap items-center gap-2'>
            <Badge variant={severityToBadgeVariant[severity]}>
              {statusDef?.label ?? currentRow.status}
            </Badge>
            {hasClaim && (
              <Button
                variant='default'
                size='sm'
                className='h-6 px-2 text-xs'
                onClick={() => openClaimSheet(currentRow)}
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
                onClick={() => void openSavedClaim(currentRow)}
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
          <RecordFindings task={currentRow} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

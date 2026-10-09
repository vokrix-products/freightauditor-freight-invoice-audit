import { createPortal } from 'react-dom'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronLeft, ChevronRight, Compass, X } from 'lucide-react'
import { RECORDS_LABEL, SHOW_TASKS_NAV, TASKS_NAV_LABEL } from '@/product-config'
import { BorderBeam } from '@/components/magicui/border-beam'
import { PulsatingButton } from '@/components/magicui/pulsating-button'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface TourStep {
  /** Selector for the element to highlight, e.g. "[data-tour='upload']". */
  target: string
  title: string
  body: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const PAD = 6 // dim stops this far outside the highlighted element
const MARGIN = 12 // minimum distance from the viewport edge
const GAP = 12 // gap between the highlight and the card

// Kept in step with the poller: a rate agreement is only useful once it has
// been processed into a record, which is what later invoices are priced
// against. Uploading an invoice first leaves it unaudited.
// A target that exists but is not rendered - the sidebar on a narrow screen, or
// a card this account's data does not produce - cannot be pointed at, so those
// steps are passed over rather than shown against an empty rectangle.
function isVisible(element: Element | null): element is Element {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

const NAV_SHORT = SHOW_TASKS_NAV ? TASKS_NAV_LABEL : 'the records page'

export const PRODUCT_TOUR_STEPS: TourStep[] = [
  {
    target: "[data-tour='welcome']",
    title: 'Your audit results live here',
    body: "Upload a carrier rate agreement, then its invoices — every discrepancy we find shows up on this page: overcharges, billing errors, and the figures behind each one.\n\nThe five numbers at the top are your totals. The cards below are the individual findings. Takes 60 seconds to walk through — Esc skips it, the button up here replays it.",
    placement: 'bottom',
  },
  {
    target: "[data-tour='sidebar']",
    title: 'Getting around',
    body: `Dashboard is where your results live. ${RECORDS_LABEL} is every file you’ve uploaded — status, findings, notes. The links at the bottom go to Support, Audit Log, and Help.`,
    placement: 'right',
  },
  {
    target: "[data-tour='sidebar-support']",
    title: 'Support',
    body: 'Raise a ticket with us: something broken, a question about your account, or a document the audit read wrongly. A person answers it, so use this when a figure looks wrong and you want it checked rather than guessed at.',
    placement: 'right',
  },
  {
    target: "[data-tour='sidebar-audit']",
    title: 'Audit Log',
    body: 'The dated history of your account: sign-ins, uploads, and which documents were processed, each with its time. Use it to confirm when something arrived, or to show what happened on a given day.',
    placement: 'right',
  },
  {
    target: "[data-tour='sidebar-help']",
    title: 'Help',
    body: 'The written guide: what each check does, how a contract rate is applied to a lane, and what every status means. Worth reading once before you act on a figure.',
    placement: 'right',
  },
  {
    target: "[data-tour='search']",
    title: 'Search',
    body: 'Jump anywhere without the sidebar. Hit Cmd+K (Ctrl+K on Windows) from any page.',
    placement: 'bottom',
  },
  {
    target: "[data-tour='notifications']",
    title: 'Notifications',
    body: 'Alerts raised for your account. The badge counts the ones you have not read, and the list refreshes itself every 30 seconds so nothing has to be reloaded.',
    placement: 'bottom',
  },
  {
    target: "[data-tour='theme']",
    title: 'Appearance',
    body: 'Light, dark, or follow your system setting. Pick whichever you can read a dense table in.',
    placement: 'bottom',
  },
  {
    target: "[data-tour='account']",
    title: 'Your account',
    body: 'Profile, Billing and Settings all open the same settings page, which is where your plan and its upload limit live. Sign out is at the bottom.',
    placement: 'bottom',
  },
  {
    target: "[data-tour='upload']",
    title: 'Upload your rate agreement first',
    body: "This box takes both: the carrier’s rate agreement and the invoices to check against it. The agreement must be uploaded first — invoices are priced against rates already on file.\n\nAn invoice uploaded without its agreement gets basic checks only (missing fields, arithmetic, duplicates) and won’t be re-audited later.\n\nOne agreement covers all future invoices from that carrier. Accepted formats: text-layer PDF, Excel, CSV, plain text. Scanned pages have no text to read — no OCR.",
    placement: 'bottom',
  },
  {
    target: "[data-tour='stats']",
    title: 'The five numbers explained',
    body: `${RECORDS_LABEL} — total invoice files processed. A re-upload counts as a new one.\n\nFlagged for Review — records the audit thinks a person should look at.\n\nOvercharges Found — money billed above your contracted rate, and how many invoices it appeared on.\n\nRate Agreements Expired — agreements past their end date. Counted per agreement, not per lane.\n\nCharges Reviewed — invoice totals added up across all audits. Re-uploads don’t inflate it.`,
    placement: 'bottom',
  },
  {
    target: "[data-tour='breakdown']",
    title: 'What happened to each file you uploaded',
    body: "After you upload a carrier invoice or rate agreement, we run checks on it — looking for overcharges, missing data, expired rates, and billing errors. Each file gets a status based on what we found.\n\nThis chart shows how your uploads are spread across those outcomes.\n\nValid — no issues found.\nFlagged — something needs attention: an overcharge, duplicate, or number that doesn’t add up.\nMissing — we couldn’t find a required piece of information on the document.\nExpired — the rate agreement has passed its end date.\nContract-Review — we couldn’t price this shipment against your contract. Needs a manual check.\nUnmapped — we couldn’t tell what type of document this is.",
    placement: 'bottom',
  },
  {
    target: "[data-tour='activity']",
    title: 'Recent Activity',
    body: `The last records written, newest first, with the carrier and the date. The quickest way to confirm that an upload you just made was processed. Every document, with its notes, is under ${NAV_SHORT}.`,
    placement: 'top',
  },
  {
    target: "[data-tour='agreements']",
    title: 'Rate Agreements on File',
    body: "Every rate agreement the audit has on file: the carrier, how many lanes it covers, and its expiry date. An invoice whose lane matches nothing here is left untouched rather than priced from a rate the contract does not promise.\n\nCheck this after uploading an agreement. If it is not listed, it was not read as one, and its invoices will not be audited against it.",
    placement: 'top',
  },
  {
    target: "[data-testid='assistant-button']",
    title: 'The assistant',
    body: "A chat about the product itself: how the audit works, what a status means, what to try next. It cannot see your uploaded files or your records, so for anything about your own data use Support. A session allows up to 20 messages; refreshing starts a new one.",
    placement: 'top',
  },
  {
    target: "[data-tour='tour-start']",
    title: 'Replay this walkthrough',
    body: 'This button runs the tour again whenever you want it. It plays once on its own the first time you open the dashboard.',
    placement: 'bottom',
  },
]

interface TourContextValue {
  start: () => void
  isOpen: boolean
  hasSeen: boolean
}

const TourContext = createContext<TourContextValue | null>(null)

export function useProductTour() {
  const context = useContext(TourContext)
  if (!context) {
    throw new Error('useProductTour must be used inside a ProductTourProvider')
  }
  return context
}

export function ProductTourProvider({
  steps = PRODUCT_TOUR_STEPS,
  storageKey,
  children,
}: {
  /** Must be a stable reference — a module constant, not an inline literal. */
  steps?: TourStep[]
  /** Null while the session is still loading; the tour waits rather than guessing. */
  storageKey: string | null
  children: React.ReactNode
}) {
  const [index, setIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<Rect | null>(null)
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 })
  const [hasSeen, setHasSeen] = useState(true)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // Skips forward past any step whose element is not on the page, so a step is
  // never shown pointing at nothing.
  const findFrom = useCallback(
    (from: number) => {
      for (let i = from; i < steps.length; i += 1) {
        if (isVisible(document.querySelector(steps[i].target))) return i
      }
      return -1
    },
    [steps]
  )

  const findBack = useCallback(
    (from: number) => {
      for (let i = from; i >= 0; i -= 1) {
        if (isVisible(document.querySelector(steps[i].target))) return i
      }
      return -1
    },
    [steps]
  )

  const finish = useCallback(() => {
    setOpen(false)
    setRect(null)
    if (storageKey) localStorage.setItem(storageKey, 'done')
    setHasSeen(true)
  }, [storageKey])

  const start = useCallback(() => {
    const first = findFrom(0)
    if (first === -1) return
    setIndex(first)
    setOpen(true)
  }, [findFrom])

  const next = useCallback(() => {
    const found = findFrom(index + 1)
    if (found === -1) {
      finish()
      return
    }
    setIndex(found)
  }, [index, findFrom, finish])

  const previous = useCallback(() => {
    const found = findBack(index - 1)
    if (found !== -1) setIndex(found)
  }, [index, findBack])

  // Runs once per person, after the first paint. The delay lets the async
  // queries settle so the first step points at a card that is really there.
  useEffect(() => {
    if (!storageKey) return
    const seen = localStorage.getItem(storageKey) === 'done'
    setHasSeen(seen)
    if (seen) return
    const timer = window.setTimeout(start, 1200)
    return () => window.clearTimeout(timer)
  }, [storageKey, start])

  // Follows the element: measured on each step, again once a smooth scroll has
  // settled, and on every scroll or resize in between.
  useEffect(() => {
    if (!open) {
      setRect(null)
      return
    }
    const step = steps[index]
    if (!step) return
    const element = document.querySelector(step.target)
    if (!element) return

    let frame = 0
    const measure = () => {
      const box = element.getBoundingClientRect()
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height })
    }
    const onMove = () => {
      measure()
    }

    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    frame = requestAnimationFrame(measure)
    const settle = window.setTimeout(measure, 350)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)

    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(settle)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, index, steps])

  useLayoutEffect(() => {
    if (!open || !cardRef.current) return
    const { width, height } = cardRef.current.getBoundingClientRect()
    setCardSize((current) =>
      current.width === width && current.height === height
        ? current
        : { width, height }
    )
  }, [open, index, rect])

  useEffect(() => {
    if (open) cardRef.current?.focus()
  }, [open, index])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish()
      } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault()
        next()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        previous()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, finish, next, previous])

  const step = steps[index]
  const isLast = findFrom(index + 1) === -1

  const cardStyle = useMemo(() => {
    if (!rect || !cardSize.width || !step) return undefined
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const placement = step.placement ?? 'bottom'

    let top: number
    let left: number

    if (placement === 'top' || placement === 'bottom') {
      top =
        placement === 'bottom'
          ? rect.top + rect.height + PAD + GAP
          : rect.top - PAD - GAP - cardSize.height
      left = rect.left + rect.width / 2 - cardSize.width / 2
    } else {
      left =
        placement === 'right'
          ? rect.left + rect.width + PAD + GAP
          : rect.left - PAD - GAP - cardSize.width
      top = rect.top + rect.height / 2 - cardSize.height / 2
    }

    // Flips to the other side of the element rather than covering it up, which
    // is what happens if the card is only clamped back into the viewport.
    if (placement === 'bottom' && top + cardSize.height > viewportHeight - MARGIN) {
      top = rect.top - PAD - GAP - cardSize.height
    }
    if (placement === 'top' && top < MARGIN) {
      top = rect.top + rect.height + PAD + GAP
    }

    const clamp = (value: number, limit: number) =>
      Math.min(Math.max(value, MARGIN), Math.max(MARGIN, limit))

    return {
      top: clamp(top, viewportHeight - cardSize.height - MARGIN),
      left: clamp(left, viewportWidth - cardSize.width - MARGIN),
    }
  }, [rect, cardSize, step])

  const overlay =
    open && rect && step
      ? createPortal(
          <div role='dialog' aria-modal='true' aria-label='Guided walkthrough'>
            {/* Four rects rather than one dimmed sheet with a hole punched in
                it, so the highlighted element stays genuinely clickable —
                clicking through to the real control is the point of a
                walkthrough. */}
            {(() => {
              const hole = {
                top: Math.max(0, rect.top - PAD),
                left: Math.max(0, rect.left - PAD),
                right: Math.min(window.innerWidth, rect.left + rect.width + PAD),
                bottom: Math.min(window.innerHeight, rect.top + rect.height + PAD),
              }
              const holeHeight = hole.bottom - hole.top
              const holeWidth = hole.right - hole.left
              return (
                <>
                  <div
                    className='fixed z-[100] bg-black/60'
                    style={{ top: 0, left: 0, right: 0, height: hole.top }}
                  />
                  <div
                    className='fixed z-[100] bg-black/60'
                    style={{ top: hole.bottom, left: 0, right: 0, bottom: 0 }}
                  />
                  <div
                    className='fixed z-[100] bg-black/60'
                    style={{
                      top: hole.top,
                      left: 0,
                      width: hole.left,
                      height: holeHeight,
                    }}
                  />
                  <div
                    className='fixed z-[100] bg-black/60'
                    style={{
                      top: hole.top,
                      left: hole.right,
                      right: 0,
                      height: holeHeight,
                    }}
                  />
                  <div
                    className='pointer-events-none fixed z-[101] rounded-lg ring-2 ring-primary/70'
                    style={{
                      top: hole.top,
                      left: hole.left,
                      width: holeWidth,
                      height: holeHeight,
                    }}
                  >
                    <BorderBeam duration={6} colorFrom='#5e6ad2' />
                  </div>
                </>
              )
            })()}
            <div
              ref={cardRef}
              tabIndex={-1}
              style={cardStyle}
              className={cn(
                'fixed z-[102] w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none',
                !cardSize.width && 'opacity-0'
              )}
            >
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <p className='text-xs font-medium text-muted-foreground'>
                    Step {index + 1} of {steps.length}
                  </p>
                  <h2 className='mt-1 text-sm font-semibold'>{step.title}</h2>
                </div>
                <button
                  type='button'
                  onClick={finish}
                  aria-label='Close the walkthrough'
                  className='rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
                >
                  <X className='size-4' />
                </button>
              </div>
              <p className='mt-2 whitespace-pre-line text-sm text-muted-foreground'>{step.body}</p>
              <div className='mt-4 flex items-center justify-between'>
                <Button variant='ghost' size='sm' onClick={finish}>
                  Skip
                </Button>
                <div className='flex items-center gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={previous}
                    disabled={findBack(index - 1) === -1}
                  >
                    <ChevronLeft className='size-4' />
                    Back
                  </Button>
                  <Button size='sm' onClick={next}>
                    {isLast ? 'Finish' : 'Next'}
                    {!isLast && <ChevronRight className='size-4' />}
                  </Button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      : null

  const value = useMemo(
    () => ({ start, isOpen: open, hasSeen }),
    [start, open, hasSeen]
  )

  return (
    <TourContext.Provider value={value}>
      {children}
      {overlay}
    </TourContext.Provider>
  )
}

/** Restarts the walkthrough. Pulses until it has been seen once. */
export function TourTrigger() {
  const { start, isOpen, hasSeen } = useProductTour()

  if (!hasSeen) {
    return (
      <PulsatingButton
        type='button'
        onClick={start}
        disabled={isOpen}
        data-tour='tour-start'
        className='gap-2 border bg-card px-4 py-2 text-sm font-medium hover:bg-accent'
      >
        <Compass className='size-4' />
        Take the tour
      </PulsatingButton>
    )
  }

  return (
    <Button
      variant='outline'
      size='sm'
      onClick={start}
      disabled={isOpen}
      data-tour='tour-start'
    >
      <Compass className='size-4' />
      Take the tour
    </Button>
  )
}

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
export const PRODUCT_TOUR_STEPS: TourStep[] = [
  {
    target: "[data-tour='welcome']",
    title: 'This is your dashboard',
    body: 'Five numbers at the top, then the documents behind them. This walkthrough points at each part. You can leave at any step and start it again from the button in this corner.',
    placement: 'bottom',
  },
  {
    target: "[data-tour='upload']",
    title: 'Upload a rate agreement first',
    body: "Drop a PDF, Excel, CSV or plain-text file here. An invoice is only audited against rates that are already on file, so upload the carrier's agreement before its invoices. Scanned PDFs without a text layer will not extract — there is no OCR.",
    placement: 'bottom',
  },
  {
    target: "[data-tour='stats']",
    title: 'What the audit found',
    body: 'Invoices processed, what is flagged for a human, the money billed above contracted rate, agreements gone stale, and the total charges reviewed. Money is counted once per invoice, so re-uploading a file does not inflate it.',
    placement: 'bottom',
  },
  {
    target: "[data-tour='breakdown']",
    title: 'Every record, by status',
    body: 'valid:good, flagged:critical, missing:critical, expired:warning, contract-review:warning, unmapped:warning. Rate agreements are counted once per agreement rather than once per lane.',
    placement: 'bottom',
  },
  {
    target: "[data-tour='activity']",
    title: 'What arrived most recently',
    body: 'The last records written, newest first. Open one to read its notes — that is where an overcharge is explained in plain English, with the figures it was calculated from.',
    placement: 'top',
  },
  {
    target: "[data-tour='agreements']",
    title: 'The contracts behind the audit',
    body: 'Every rate agreement on file, the lanes each covers, and its expiry. An invoice whose lane matches nothing here is left untouched rather than guessed at.',
    placement: 'top',
  },
  {
    target: "[data-tour='tour-start']",
    title: 'Run this again any time',
    body: 'This button replays the walkthrough. It runs once on its own the first time you open the dashboard.',
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
        if (document.querySelector(steps[i].target)) return i
      }
      return -1
    },
    [steps]
  )

  const findBack = useCallback(
    (from: number) => {
      for (let i = from; i >= 0; i -= 1) {
        if (document.querySelector(steps[i].target)) return i
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
              <p className='mt-2 text-sm text-muted-foreground'>{step.body}</p>
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

'use client'

/**
 * A demonstration that plays itself: `useTour` steps it through its own states until someone
 * touches it, and `TourBar` is the hairline that says when the next step comes.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useInView, useReducedMotion } from './hooks'
import { stage } from './stage'

/**
 * A demonstration that plays itself. Nobody arriving at a section knows it is waiting for a press,
 * so it doesn't wait: it moves through its own states, one every few seconds, and a hairline on
 * its frame that shrinks says when the next one comes. The moment someone touches the demonstration it is
 * theirs, and it only carries on by itself once it has been left alone for a while.
 */
export interface Tour {
  /** The step that comes next, counted from 0. */
  next: number
  /** True while the bar is shrinking toward the next step. */
  running: boolean
  /**
   * True while the tour, and not a person, is what is changing the demonstration. Anything that
   * announces changes to a screen reader should go quiet while this is true.
   */
  auto: boolean
  /** How long the bar now showing takes to run out, in seconds. */
  seconds: number
  /** Goes up by one every time the bar starts again, so the bar can be told to. */
  round: number
  /** True once someone has pressed pause; only pressing play ends it. */
  paused: boolean
  toggle: () => void
  /** True where nothing may play by itself: someone asked their device for less motion. */
  off: boolean
}

export function useTour({
  ref,
  steps,
  seconds = 5,
  first,
  rest = 9,
  band = '-15% 0px -15% 0px',
}: {
  /** The demonstration's own element: the tour runs while it is on screen, and yields to any press or key inside it. */
  ref: RefObject<HTMLElement | null>
  /** What each step does to the demonstration, in order. After the last comes the first again. */
  steps: (() => void)[]
  /**
   * How long the bar runs before each step: one number for all of them, or one for each. A few
   * seconds where a step only changes a state; as long as the story takes where it sets people
   * walking (the first screen holds its day 18).
   */
  seconds?: number | number[]
  /** How long before the very first step, if that should differ. */
  first?: number
  /** How long after someone last touched it before it carries on by itself. */
  rest?: number
  /**
   * How much of the screen counts as on screen, as an IntersectionObserver margin: the middle of
   * it unless said, so a demonstration at the very edge of the screen isn't playing unseen.
   */
  band?: string
}): Tour {
  const reduced = useReducedMotion()
  const inView = useInView(ref, band)
  const [next, setNext] = useState(0)
  const [round, setRound] = useState(0)
  const [paused, setPaused] = useState(false)
  const [held, setHeld] = useState(false)
  const [auto, setAuto] = useState(true)
  // Whether anyone has used the demonstration yet: the short first window is only for one that
  // nobody has, or a press in the first seconds would get the tour back with a few seconds to go.
  const [met, setMet] = useState(false)
  const latest = useRef(steps)
  latest.current = steps

  const wait =
    round === 0 && !met && first !== undefined
      ? first
      : Array.isArray(seconds)
        ? (seconds[next] ?? 5)
        : seconds
  const running = inView && !reduced && !paused && !held && steps.length > 0
  const latestWait = useRef(wait)
  latestWait.current = wait
  // The bar now showing: how long it runs, and a number that changes whenever it starts again.
  const [bar, setBar] = useState({ run: 0, seconds: wait })

  // The countdown: when the bar runs out, the next step is taken and the bar starts again. The
  // window is fixed when the countdown starts (after a step, or on carrying on after a pause), so
  // the bar and the countdown always run out together, whatever happens to `seconds` meanwhile.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` restarts the countdown after every step
  useEffect(() => {
    if (!running) return
    const window = latestWait.current
    setBar((was) => ({ run: was.run + 1, seconds: window }))
    const timer = setTimeout(() => {
      setAuto(true)
      latest.current[next % latest.current.length]?.()
      setNext((index) => (index + 1) % latest.current.length)
      setRound((count) => count + 1)
    }, window * 1000)
    return () => clearTimeout(timer)
  }, [running, next, round])

  // Someone using the demonstration takes it over; it is given back once they have let it be.
  useEffect(() => {
    const element = ref.current
    if (!element || reduced) return
    let idle: ReturnType<typeof setTimeout> | undefined
    const touched = (event: Event) => {
      // The tour's own pause button is not the demonstration being used.
      if ((event.target as Element | null)?.closest?.('[data-tour]')) return
      // Nor is a finger that lands here on its way to scrolling the page: a touch counts once it
      // becomes a press (a click) or moves a control (an input).
      if (event.type === 'pointerdown' && (event as PointerEvent).pointerType === 'touch') return
      setAuto(false)
      setMet(true)
      setHeld(true)
      clearTimeout(idle)
      idle = setTimeout(() => setHeld(false), rest * 1000)
    }
    // A click as well as a press: a screen reader or voice control activates a button with a
    // click alone, and the tour's own steps never make one.
    const kinds = ['pointerdown', 'click', 'keydown', 'input'] as const
    for (const kind of kinds) element.addEventListener(kind, touched)
    return () => {
      clearTimeout(idle)
      for (const kind of kinds) element.removeEventListener(kind, touched)
    }
  }, [ref, reduced, rest])

  // A paused demonstration holds still what moves by itself beside it, for as long as it is on
  // screen: the water, the leaves, whoever is walking about.
  useEffect(() => {
    if (!paused || !inView) return
    stage.set({ held: stage.get().held + 1 })
    return () => stage.set({ held: stage.get().held - 1 })
  }, [paused, inView])

  const toggle = useCallback(() => {
    setPaused((now) => !now)
    setHeld(false)
  }, [])

  return {
    next,
    running,
    // Whose doing the last change was stays so while the tour is paused or out of view: the rest
    // of a sequence the tour began is still the tour's, and isn't read out as a person's.
    auto: auto && !reduced,
    seconds: bar.seconds,
    round: bar.run,
    paused,
    toggle,
    off: reduced,
  }
}

/**
 * The tour's countdown, and its pause button. It takes no room: the countdown is a hairline drawn
 * just inside the top edge of the demonstration's own frame, shrinking as the window runs out, and
 * the pause button shows only when the frame is hovered or the button has the keyboard's focus.
 * `label` (what the next step is) is not shown; it is said with the pause button for a screen
 * reader. A demonstration with two halves that are never seen together may have a tour for each.
 */
export function TourBar({
  tour,
  label,
  name,
}: {
  tour: Tour
  label?: string
  /** What this bar's tour plays, where one demonstration has two: "the week". */
  name?: string
  /** No longer used: the bar is drawn on the frame and has no box of its own to style. */
  className?: string
}) {
  const marker = useRef<HTMLSpanElement>(null)
  const [frame, setFrame] = useState<Element | null>(null)
  // The bar is drawn on the frame the demonstration sits in, wherever in it this is rendered.
  useEffect(() => {
    setFrame(marker.current?.closest('[data-tour-frame], .bl-demo__body') ?? null)
  }, [])
  if (tour.off) return null
  const state = tour.paused ? 'paused' : tour.running ? 'running' : 'held'
  return (
    <>
      <span ref={marker} hidden />
      {frame &&
        createPortal(
          <div className="bl-tour" data-tour data-state={state}>
            <span className="bl-tour__track" aria-hidden>
              <span
                key={tour.round}
                className="bl-tour__bar"
                style={{ animationDuration: `${tour.seconds}s` }}
              />
            </span>
            <button
              type="button"
              className="bl-tour__toggle"
              onClick={tour.toggle}
              aria-pressed={tour.paused}
              // One name, and `aria-pressed` says which state it is in.
              aria-label={`Pause ${name ?? 'this demonstration'}${
                label && !tour.paused ? `. Next: ${label}` : ''
              }`}
            >
              <i aria-hidden />
            </button>
          </div>,
          frame,
        )}
    </>
  )
}

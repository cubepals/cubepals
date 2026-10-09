'use client'

/**
 * A beat of the film: a screen with a shot, one sentence and its proof (`Beat`), and what plays it
 * (`useBeat`): cues on a clock of the beat's own, which runs by itself and which the reader's
 * scrolling hurries or runs backwards (clock.ts).
 */
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { type RoomKey, roomY } from '../engine/chunk'
import { useReducedMotion } from '../hooks'
import { type Shot, shotAttributes, type Tone, type Zoom } from '../kit'
import { playing } from './clock'
import styles from './film.module.css'
import { Proof } from './Proof'

/** How long after its last cue a beat is still playing: the picture finishing what the cue began. */
const TAIL = 1.6

/** One thing a beat does: how long after the page comes to rest on it, in seconds, and what. */
export type Cue = readonly [after: number, run: () => void]

/** What a beat's own component hands to its `Beat`: where it is, and how its proof stands. */
export interface Playing {
  at: RefObject<HTMLElement | null>
  bar: RefObject<HTMLElement | null>
  /** Ends the beat now: whoever was reading it has done what it was for. */
  done: () => void
  /** Whether the page is resting on it. */
  on: boolean
  open: boolean
  onOpen: (open: boolean) => void
}

/**
 * Plays a beat. When the page comes to rest on it, its cues run in order, once; leave it and they
 * stop where they are; come back and it plays again from the start. Nothing here loops: a beat
 * plays, and holds on how it ended. Someone who asked for less motion gets the end at once.
 *
 * It plays at its own pace, and scrolling moves it: scrolling on hurries its story along, and
 * scrolling back plays it backwards. The page stays on the beat until it has finished, or is
 * back at its start (clock.ts). A hairline at the foot of the screen says how far it has got.
 *
 * While its proof is open the demonstration there has the picture, and the beat's own cues are
 * stopped; shut, the beat plays again from the start.
 *
 * `first` is how the beat's room stands before anyone has reached it, said once as the page
 * loads: a room is first drawn on the way to it, and it should be found as the beat begins, not
 * part-way through a round of its own.
 */
export function useBeat(cues: () => readonly Cue[], first?: () => void): Playing {
  const at = useRef<HTMLElement>(null)
  const [on, setOn] = useState(false)
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotion()
  // The cues are made afresh on every arrival, so they always close over what is so now.
  const made = useRef(cues)
  made.current = cues
  if (open && !on) setOpen(false)
  const opening = useRef(first)
  useEffect(() => opening.current?.(), [])
  // The hairline that shows how far the beat has played, written straight onto the page.
  const bar = useRef<HTMLElement>(null)
  // Whether the beat was told it is over before its clock ran out.
  const over = useRef(false)

  useEffect(() => {
    const element = at.current
    if (!element) return
    // On it when most of it is on screen: a ride lands with the whole beat in view.
    const observer = new IntersectionObserver(([entry]) => setOn((entry?.intersectionRatio ?? 0) > 0.7), {
      threshold: [0.3, 0.7],
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!on || open) return
    const cues = [...made.current()].sort((a, b) => a[0] - b[0])
    if (reduced) {
      for (const [, run] of cues) run()
      return
    }
    // The beat's own clock. It runs by itself; scrolling on hurries it and scrolling back runs
    // it backwards (clock.ts). The page stays on the beat until it has run out (its last cue,
    // and a moment for the picture to finish what that cue began) or is back at its start. A
    // beat with nothing to play holds nobody.
    const last = cues[cues.length - 1]?.[0] ?? 0
    const ends = last > 0 ? last + TAIL : 0
    // How many of its cues are in force. Going forward the next ones are run as their moment
    // passes. Gone back past one, the beat says again everything up to where it now is, from the
    // top: each cue says how things stand, so the picture goes back to how it stood then.
    let applied = 0
    // How many cues have their moment at or before `t`: they are in order, so it is a short walk
    // from where it last stood, either way, and nothing is made on a frame to find it.
    let reached = 0
    const reachedAt = (t: number) => {
      while (reached < cues.length && (cues[reached] as Cue)[0] <= t) reached += 1
      while (reached > 0 && (cues[reached - 1] as Cue)[0] > t) reached -= 1
      return reached
    }
    const apply = (count: number) => {
      if (count === applied) return
      const from = count < applied ? 0 : applied
      playing.back = count < applied
      for (let n = from; n < count; n++) (cues[n] as Cue)[1]()
      playing.back = false
      applied = count
    }
    // Come to from below, it is found as it ended, and scrolling up plays it back from there.
    let t = playing.heading < 0 ? ends : 0
    if (t > 0) apply(cues.length)
    let before = performance.now()
    let frame = 0
    let drawn = -1
    const line = bar.current
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - before) / 1000)
      before = now
      playing.push *= Math.exp(-dt * 3)
      if (Math.abs(playing.push) < 0.02) playing.push = 0
      const backwards = playing.push < -0.15
      const rate = backwards ? playing.push * 1.5 : 1 + Math.max(0, playing.push)
      playing.pace = Math.max(1, Math.abs(rate))
      t = over.current ? ends : Math.min(ends, Math.max(0, t + dt * rate))
      apply(reachedAt(t))
      playing.at = t
      // The hairline is written only when it has moved a step, not on every frame.
      const shown = ends > 0 && t < ends ? Math.round((t / ends) * 400) / 400 : 0
      if (line && shown !== drawn) {
        line.style.scale = `${shown} 1`
        drawn = shown
      }
      playing.set(t < ends)
      // Back at its start under a hand still scrolling up: the same scroll goes on up the page.
      if (backwards && t <= 0) playing.tell()
      frame = requestAnimationFrame(tick)
    }
    over.current = false
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      playing.at = 0
      playing.pace = 1
      playing.push = 0
      playing.set(false)
      if (line) line.style.scale = '0 1'
    }
  }, [on, open, reduced])

  const onOpen = useCallback((next: boolean) => setOpen(next), [])
  const done = useCallback(() => {
    over.current = true
  }, [])
  return { at, bar, on, open, onOpen, done }
}

/**
 * One beat of the film: a screen, held, with the picture the whole of it. `room` (or `y`), `zoom`
 * and `shot` say where the camera stands; `line` is the one sentence up just now, in a caption;
 * `proof` is the section that demonstrates it, opened by whoever wants it and shut again when the
 * page moves on. Anything else on the screen is its children.
 */
export function Beat({
  at,
  bar,
  id,
  name,
  tone,
  room,
  y,
  zoom,
  shot,
  act,
  sky,
  cue,
  side = 'center',
  line,
  place,
  proof,
  says = 'How it works',
  closing,
  open,
  onOpen,
  className,
  children,
}: Omit<Playing, 'on' | 'done'> & {
  id?: string
  name: string
  tone: Tone | 'dusk'
  room?: RoomKey
  y?: number
  zoom?: Zoom
  shot?: Shot
  act?: 'play' | 'ledger' | 'friends' | 'knock'
  /** Under the night sky, which turns with the day. */
  sky?: boolean
  /** What the cue at the foot of the screen says, in place of "Next: …". */
  cue?: string
  side?: 'left' | 'right' | 'center' | number
  line?: string
  place?: 'top'
  /** The proof: the section that demonstrates this beat, as it is on the long page. */
  proof?: ReactNode
  /** What the way in to the proof says. */
  says?: string
  /** The page's own button is on this beat, so the one that follows the reader steps aside. */
  closing?: boolean
  className?: string
  children?: ReactNode
}) {
  // With the proof open the picture steps aside for it, and comes back when it shuts. The camera
  // and the rides read where a section stands when the page is measured, so they are told to.
  const stands = open ? 'left' : side
  const shown = useRef(stands)
  useEffect(() => {
    if (shown.current === stands) return
    shown.current = stands
    window.dispatchEvent(new Event('resize'))
  }, [stands])
  return (
    <section
      ref={at}
      // Every beat answers to a name, so the gauge and a sent link can reach it.
      id={
        id ??
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      }
      className={
        className ? `bl-section bl-beat ${styles.beat} ${className}` : `bl-section bl-beat ${styles.beat}`
      }
      data-name={name}
      data-cue={cue}
      data-tone={tone}
      data-sky={sky || undefined}
      data-room={room}
      data-y={room ? roomY(room) : y}
      data-side={stands}
      data-open={open || undefined}
      data-zoom={zoom ?? (room ? 'close' : 'wide')}
      // With the proof open the picture has half the screen, so it stands a little further back.
      {...shotAttributes(open && shot?.span ? { ...shot, span: shot.span * 1.3 } : shot)}
      data-act={act}
      data-closing={closing || undefined}
    >
      <div className={styles.held} data-scene>
        {children}
        {line && (
          // Keyed by what it says, so a new line is a new strip stamped on, not the old one edited.
          <p key={line} className={styles.caption} data-place={place} data-over>
            <span>{line}</span>
          </p>
        )}
        <i ref={bar} className={styles.through} aria-hidden />
        {proof && (
          <Proof says={says} label={`${name}: how it works`} open={open} onOpen={onOpen}>
            {proof}
          </Proof>
        )}
      </div>
    </section>
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The parts under every world, read one at a time: the stack's drawing in a window that stays on
 * the screen while the steps beside it (under it, on a phone) scroll past, and the step across the
 * reading line is the part the drawing opens at. The island's print is chosen for the screen's
 * density, so it is shown dot for dot (island/dots.ts), and the drawing is worked out for that print
 * and the room there is. Nothing holds the scroll: the browser scrolls the page as it always does.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from '../hooks'
import { unitOf } from '../island/dots'
import { SMALL, STILLS } from '../island/stills'
import { Drawing } from './Drawing'
import { stackOf } from './geometry'
import { Motion, type Step } from './motion'
import styles from './stack.module.css'
import { NOTES, type Told } from './tops'

/** One step of the reading: the part it opens, its count, and what it says. */
export interface Said {
  step: Step
  count: string
  title: string
  said: string
}

/** The island's prints, smallest first: the one shown is the largest whose dots fit the room on this screen. */
const PRINTS = [
  { leave: SMALL.leave, join: SMALL.join },
  { leave: STILLS.leave.coarse, join: STILLS.join.coarse },
  { leave: STILLS.leave.fine, join: STILLS.join.fine },
] as const

/** What the drawing tries, in turn, until one fits its window: room for the island, and whether the players and names are drawn. */
const TRIES = [
  { room: 470, told: true },
  { room: 400, told: true },
  { room: 340, told: false },
] as const

/** The largest print whose dots make it no wider than `room` on a screen of `ratio` device pixels a CSS pixel. */
export function printFor(room: number, ratio: number) {
  const unit = unitOf(ratio)
  const chosen = PRINTS.filter((print) => print.leave.width * unit <= room).at(-1) ?? PRINTS[0]
  return { chosen, print: { across: chosen.leave.width, down: chosen.leave.height, unit } }
}

/** The stack worked out for a window `width` wide on a screen of `ratio`: the first try that fits it, or the last. */
function drawnFor(width: number, ratio: number, bedrock: boolean) {
  const tried = TRIES.map((tri) => {
    const { chosen, print } = printFor(tri.room, ratio)
    const stack = stackOf(print, { players: tri.told, bedrock, notes: tri.told ? NOTES : null })
    return { stack, prints: { leave: chosen.leave.src, join: chosen.join.src } }
  })
  return tried.find((one) => one.stack.width <= width) ?? (tried.at(-1) as (typeof tried)[number])
}

/** The step across the reading line: the last whose top has passed it, or none before the first has. */
function readAt(list: HTMLOListElement, line: number): Step | null {
  let read: Step | null = null
  for (const item of list.querySelectorAll<HTMLElement>('[data-step]')) {
    if (item.getBoundingClientRect().top <= line) read = item.dataset.step as Step
  }
  return read
}

/** Moves the drawing as the page is read: opens it once it is seen, and shows the step across the reading line. */
function useReading(
  drawn: ReturnType<typeof drawnFor> | null,
  id: string,
  still: boolean,
  parts: { window: HTMLDivElement | null; list: HTMLOListElement | null },
) {
  const { window: frame, list } = parts
  useEffect(() => {
    if (!drawn || !frame || !list) return
    const motion = new Motion(frame, drawn.stack, id, () => frame.clientHeight, still)
    let shown: Step | null = null
    let asked = 0
    const read = () => {
      asked = 0
      const box = frame.getBoundingClientRect()
      const wide = list.getBoundingClientRect().left > box.left
      // The middle of the room the steps are read in: the screen's, or on a narrow one the room under the window.
      const line = wide ? window.innerHeight / 2 : (box.bottom + window.innerHeight) / 2
      const step = readAt(list, line)
      if (step === shown) return
      shown = step
      for (const item of list.querySelectorAll<HTMLElement>('[data-step]'))
        item.toggleAttribute('data-on', item.dataset.step === step)
      if (step) motion.show(step)
    }
    const ask = () => {
      if (!asked) asked = requestAnimationFrame(read)
    }
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          seen.disconnect()
          motion.open()
        }
      },
      { threshold: 0.35 },
    )
    seen.observe(frame)
    const sized = new ResizeObserver(() => motion.resized())
    sized.observe(frame)
    window.addEventListener('scroll', ask, { passive: true })
    read()
    return () => {
      cancelAnimationFrame(asked)
      seen.disconnect()
      sized.disconnect()
      window.removeEventListener('scroll', ask)
      motion.dispose()
    }
  }, [drawn, id, still, frame, list])
}

export function Stack({ steps, told, bedrock }: { steps: readonly Said[]; told: Told; bedrock: boolean }) {
  const id = `stack${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const still = useReducedMotion()
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const [list, setList] = useState<HTMLOListElement | null>(null)
  const [screen, setScreen] = useState<{ width: number; ratio: number } | null>(null)
  const measured = useRef('')
  useEffect(() => {
    if (!frame) return
    const measure = () => {
      const next = { width: Math.floor(frame.clientWidth), ratio: window.devicePixelRatio || 1 }
      const key = `${next.width}:${next.ratio}`
      if (key === measured.current) return
      measured.current = key
      setScreen(next)
    }
    measure()
    const sized = new ResizeObserver(measure)
    sized.observe(frame)
    window.addEventListener('resize', measure)
    return () => {
      sized.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [frame])
  const drawn = useMemo(
    () => (screen ? drawnFor(screen.width, screen.ratio, bedrock) : null),
    [screen, bedrock],
  )
  useReading(drawn, id, still, { window: frame, list })
  return (
    <div className={styles.scrolly}>
      <div className={styles.figure}>
        <div ref={setFrame} className={styles.window}>
          {drawn ? <Drawing stack={drawn.stack} told={told} id={id} prints={drawn.prints} /> : null}
        </div>
        <p className={styles.caption}>A drawing of the parts under every server.</p>
      </div>
      <ol ref={setList} className={styles.steps}>
        {steps.map((one) => (
          <li key={one.step} data-step={one.step} className={styles.step}>
            <p className={styles.count}>{one.count}</p>
            <h3 className={`lp-h3 ${styles.title}`}>{one.title}</h3>
            <p className="lp-body">{one.said}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}

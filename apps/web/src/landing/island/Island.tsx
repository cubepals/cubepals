// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The island on the first screen, as the page has it: the printed still that is there at once,
 * the canvas the worker draws on once the page has loaded (drawing.ts), the drawing's measurements
 * set where the scene says its corners are (Measures.tsx), and the server's own card, which says
 * what the server is doing and lets the visitor join it or leave it (Card.tsx). A moment after it is
 * first seen, someone joins on their own: the page's one idea, played once. Scrolling is the
 * browser's own: the camera only rises a little as the first screen goes, and the mouse leans it.
 * Without a worker, OffscreenCanvas or WebGL 2, the still stays and the card still plays the
 * server's states. Not the drawing, which is scene.ts.
 */
import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '../hooks'
import { Card, HOLDS } from './Card'
import { useDrawing } from './drawing'
import styles from './island.module.css'
import { Measures } from './Measures'
import { Print } from './Print'
import { Snore } from './Snore'
import type { Asked, Marks, Power } from './scene'
import { STILL_MARKS } from './stills'

/** How long the island shows the server asleep before someone joins it, unasked, in ms. */
const JOINS_AFTER_MS = 1200
/** How long the card's own server takes to start, without the drawing, in ms. */
const STARTS_MS = 1600

export function Island({ address }: { address: string }) {
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const touched = useRef(false)
  const still = useReducedMotion()
  const [asked, setAsked] = useState<Asked>('leave')
  const [state, setState] = useState<{ power: Power; players: number }>({ power: 'sleeping', players: 0 })
  const [marks, setMarks] = useState<Marks>(STILL_MARKS)
  const { drawing, ask } = useDrawing(frame, canvas, (answer) => {
    if (answer.kind === 'state') setState({ power: answer.power, players: answer.players })
    else if (answer.kind === 'marks') setMarks(answer.marks)
  })

  // Less motion asked for: the server is shown as it ends, with everyone in, and nothing moves.
  useEffect(() => {
    if (still && !touched.current) setAsked('join')
    ask({ still })
  }, [still, ask])

  // What the visitor asked, told to the drawing. Until the drawing shows, and without one, the
  // card plays the server's states itself.
  useEffect(() => {
    ask({ asked })
    if (drawing === 'shown') return
    if (asked === 'leave') {
      setState({ power: 'sleeping', players: 0 })
      return
    }
    setState({ power: still ? 'online' : 'starting', players: still ? HOLDS - 2 : 0 })
    if (still) return
    const timer = window.setTimeout(() => setState({ power: 'online', players: HOLDS - 2 }), STARTS_MS)
    return () => clearTimeout(timer)
  }, [asked, still, drawing, ask])

  // Someone joins on their own a moment after the island is seen, once. It waits for the drawing,
  // so the wake is seen, or for the page to go on without it.
  useEffect(() => {
    const box = frame.current
    if (!box || still || drawing === 'coming') return
    let timer = 0
    const seen = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || touched.current) return
      timer = window.setTimeout(() => {
        if (!touched.current) setAsked('join')
      }, JOINS_AFTER_MS)
      seen.disconnect()
    })
    seen.observe(box)
    return () => {
      seen.disconnect()
      clearTimeout(timer)
    }
  }, [still, drawing])

  const [pressed, setPressed] = useState(false)
  const press = () => {
    touched.current = true
    setPressed(true)
    setAsked((was) => (was === 'join' ? 'leave' : 'join'))
  }

  const { power, players } = state
  return (
    <div className={styles.island} data-power={power}>
      <div ref={frame} className={styles.picture} data-shown={drawing === 'shown' || undefined} aria-hidden>
        {/* Until the drawing shows, the still, with its marks set on it; then the drawing's own. */}
        <Print which={asked}>
          {drawing !== 'shown' && <Marked marks={STILL_MARKS} asleep={power === 'sleeping'} />}
        </Print>
        <canvas ref={canvas} className={styles.canvas} />
        {drawing === 'shown' && <Marked marks={marks} asleep={power === 'sleeping'} />}
      </div>
      <Card
        address={address}
        power={power}
        players={players}
        joined={asked === 'join'}
        press={press}
        announce={pressed}
      />
      <p className={styles.note}>A drawing, sped up. Nothing is started.</p>
    </div>
  )
}

/** What is set on the picture: its measurements, and a sleeping server's snore from its chimney. */
function Marked({ marks, asleep }: { marks: Marks; asleep: boolean }) {
  return (
    <>
      <Measures marks={marks} />
      {asleep && marks.chimney && <Snore at={marks.chimney} />}
    </>
  )
}

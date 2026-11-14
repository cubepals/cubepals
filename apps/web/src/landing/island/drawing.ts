// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The page's side of the island's worker (island.worker.ts): starting it once the page has loaded,
 * handing it the canvas, and telling it whatever changes: its size, whether it is on the screen,
 * how far the first screen has scrolled, where the mouse is, and what the visitor asked. What it
 * answers comes back through `heard`. Scrolling is never waited on or held: the page only says how
 * far it has gone, after the browser has moved it. Not what is shown round the drawing, which is
 * Island.tsx.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { drawingFailed } from '../start'
import { fitted } from './dots'
import type { Answer, Told } from './island.worker'
import type { Input } from './scene'
import { withParamsInQuery } from './worker-url'

/** Whether the drawing is coming, is on the screen, or won't be: then the printed still stays. */
export type Drawing = 'coming' | 'shown' | 'none'

/** How long the drawing is waited for before the page goes on without it, in ms. */
const GIVES_UP_MS = 6000

/**
 * Starts the drawing on `canvas` once the page has loaded, and keeps it told. `heard` is given
 * every answer but the drawing's own coming and going, which is the hook's `drawing`.
 */
export function useDrawing(
  frame: RefObject<HTMLDivElement | null>,
  canvas: RefObject<HTMLCanvasElement | null>,
  heard: (answer: Answer) => void,
) {
  const worker = useRef<Worker | null>(null)
  const input = useRef<Input>({ asked: 'leave', rise: 0, lean: [0, 0], still: false })
  const visible = useRef(true)
  const listener = useRef(heard)
  listener.current = heard
  const [drawing, setDrawing] = useState<Drawing>('coming')

  const tell = useCallback(
    (told: Told, transfer: Transferable[] = []) => worker.current?.postMessage(told, transfer),
    [],
  )
  const ask = useCallback(
    (next: Partial<Input>) => {
      input.current = { ...input.current, ...next }
      tell({ kind: 'input', input: input.current })
    },
    [tell],
  )

  useEffect(() => {
    const drawn = canvas.current
    if (!drawn || !('transferControlToOffscreen' in drawn)) {
      setDrawing('none')
      return
    }
    let started: Worker | null = null
    let idle = 0
    const answered = (event: MessageEvent<Answer>) => {
      const answer = event.data
      if (answer.kind === 'shown') setDrawing('shown')
      else if (answer.kind === 'failed') {
        setDrawing('none')
        drawingFailed('frame')
      } else listener.current(answer)
    }
    const start = () => {
      try {
        started = withParamsInQuery(
          () => new Worker(new URL('./island.worker.ts', import.meta.url), { type: 'module' }),
        )
      } catch {
        drawingFailed('worker')
        setDrawing('none')
        return
      }
      started.onmessage = answered
      // A worker that won't start is as good as none: the still stays.
      started.onerror = (event) => {
        event.preventDefault()
        setDrawing('none')
        drawingFailed('worker')
      }
      worker.current = started
      const box = frame.current
      if (!box) return
      const size = sizeTo(drawn, box)
      const offscreen = drawn.transferControlToOffscreen()
      tell({ kind: 'start', canvas: offscreen, ...size, input: input.current }, [offscreen])
      if (!visible.current) tell({ kind: 'seen', seen: false })
    }
    const later = () => {
      idle =
        typeof window.requestIdleCallback === 'function'
          ? window.requestIdleCallback(start, { timeout: 1200 })
          : window.setTimeout(start, 200)
    }
    if (document.readyState === 'complete') later()
    else window.addEventListener('load', later, { once: true })
    // A device too slow to show it soon is a device better off without it.
    const waited = window.setTimeout(
      () => setDrawing((was) => (was === 'coming' ? 'none' : was)),
      GIVES_UP_MS,
    )
    return () => {
      window.removeEventListener('load', later)
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle)
      clearTimeout(idle)
      clearTimeout(waited)
      started?.terminate()
      worker.current = null
    }
  }, [frame, canvas, tell])

  useWatched(frame, canvas, visible, tell, ask)

  return { drawing, ask }
}

/**
 * Sets the canvas to as many whole dots as fit its box, so the print is shown dot for dot and never
 * scaled (dots.ts), and says the size the worker is to print at.
 */
function sizeTo(canvas: HTMLCanvasElement, box: HTMLElement) {
  const ratio = window.devicePixelRatio || 1
  const room = box.getBoundingClientRect()
  const print = fitted(room.width, room.height, ratio)
  canvas.style.width = `${print.width}px`
  canvas.style.height = `${print.height}px`
  return { width: print.width, height: print.height, ratio }
}

/**
 * What the drawing is told as the page changes: its size, whether it is on the screen (it draws
 * only then), how far the first screen has scrolled, and where a mouse is.
 */
function useWatched(
  frame: RefObject<HTMLDivElement | null>,
  canvas: RefObject<HTMLCanvasElement | null>,
  visible: RefObject<boolean>,
  tell: (told: Told) => void,
  ask: (next: Partial<Input>) => void,
) {
  useEffect(() => {
    const box = frame.current
    const drawn = canvas.current
    const hero = box?.closest('section')
    if (!box || !drawn || !hero) return
    const resize = () => tell({ kind: 'size', ...sizeTo(drawn, box) })
    const resized = new ResizeObserver(resize)
    resized.observe(box)
    // A window moved to a screen of another density is a resize too.
    window.addEventListener('resize', resize)
    const say = () => tell({ kind: 'seen', seen: visible.current && document.visibilityState === 'visible' })
    const seen = new IntersectionObserver(([entry]) => {
      visible.current = entry?.isIntersecting ?? false
      say()
    })
    seen.observe(box)
    document.addEventListener('visibilitychange', say)
    let pending = 0
    const scrolled = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        if (visible.current)
          ask({ rise: Math.min(1, Math.max(0, window.scrollY / Math.max(1, hero.offsetHeight))) })
      })
    }
    const mouse = window.matchMedia('(hover: hover) and (pointer: fine)')
    const pointed = (event: PointerEvent) => {
      if (!mouse.matches || event.pointerType !== 'mouse' || !visible.current) return
      ask({
        lean: [(event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1],
      })
    }
    window.addEventListener('scroll', scrolled, { passive: true })
    window.addEventListener('pointermove', pointed, { passive: true })
    return () => {
      resized.disconnect()
      window.removeEventListener('resize', resize)
      seen.disconnect()
      cancelAnimationFrame(pending)
      document.removeEventListener('visibilitychange', say)
      window.removeEventListener('scroll', scrolled)
      window.removeEventListener('pointermove', pointed)
    }
  }, [frame, canvas, visible, tell, ask])
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Whether the chunk gets drawn, and on which canvas. A WebGL context can fail to start, or be
 * taken away and never given back (a busy graphics card, a switch between two of them, a tab left
 * in the background), and a canvas that lost its context keeps the lost one for good. So Chunk.tsx
 * is given a new canvas when that happens (`Canvas`, `nextCanvas`), a few times in a row at most,
 * and only after that does the page go on without the drawing (`withoutDrawing`). A renderer that
 * fails once running, or a context that is lost, ends the same way (`keepDrawing`). Not the drawing
 * itself, which is engine/gl.ts, nor what the page looks like without it, which is landing.css.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { capture } from '../lib/insight'
import { stage } from './stage'

/** The canvas the chunk is drawn on: React's key for it, and how many in a row failed to start. */
export interface Canvas {
  key: number
  failed: number
}

export const FIRST_CANVAS: Canvas = { key: 0, failed: 0 }

/** A new canvas, after the last one failed to start (`failed`) or lost a context that had run. */
export const nextCanvas = (was: Canvas, failed: boolean): Canvas => ({
  key: was.key + 1,
  failed: failed ? was.failed + 1 : 0,
})

/** How many canvases in a row may fail to start before the page goes on without the drawing. */
const TRIES = 3

/** How long a lost context is waited for before the drawing is moved to a new canvas. */
const RESTORED_WITHIN_MS = 2 * SECOND_MS

/**
 * What Chunk.tsx does when its canvas has no drawing: tries a new canvas on the next frame
 * (`renew`), or, once `TRIES` canvases in a row have failed, gives the page its form without the
 * drawing (`data-flat`, landing.css). The sky there still turns from night to day when someone
 * joins, since that much is only a colour. Returns what undoes it.
 */
export function withoutDrawing(root: HTMLElement, canvas: Canvas, renew: () => void): () => void {
  if (canvas.failed + 1 < TRIES) {
    const frame = requestAnimationFrame(renew)
    return () => cancelAnimationFrame(frame)
  }
  root.dataset.flat = 'true'
  const skies = root.querySelectorAll<HTMLElement>('[data-sky]')
  const sky = () => {
    const power = stage.get().power
    const day = power === 'awake' || power === 'saving' ? '1' : '0'
    for (const element of skies) element.style.setProperty('--day', day)
  }
  sky()
  const unsubscribe = stage.subscribe(sky)
  return () => {
    unsubscribe()
    delete root.dataset.flat
  }
}

/** What stopped the drawing: it couldn't start, the renderer threw, the context was lost, or the phone's worker failed. */
export type Reason = 'start' | 'frame' | 'lost' | 'worker'

const counted = new Set<Reason>()

/** Counts a failure of the drawing in PostHog, as handled, once for each reason on a page. */
export function drawingFailed(reason: Reason): void {
  if (counted.has(reason)) return
  counted.add(reason)
  capture('landing_drawing_failed', { reason })
}

/**
 * Keeps a running renderer from ever failing the page. Whatever it throws (a program that won't
 * link, a framebuffer that can't be made, a context taken away mid-call) is counted and ends the
 * drawing as a canvas that never started does (`withoutDrawing`), and the call answers nothing.
 * A lost context is waited for, and the drawing moves to a new canvas when it comes back or when it
 * hasn't come back soon (`RESTORED_WITHIN_MS`). `halt` stops what draws; `stop`, when the canvas
 * goes, takes every listener and what `withoutDrawing` did away again.
 */
export function keepDrawing<T extends object>(
  renderer: T,
  canvas: HTMLCanvasElement,
  root: HTMLElement,
  drawn: Canvas,
  renew: (failed: boolean) => void,
  halt: () => void,
): { renderer: T; stop: () => void } {
  let undo: (() => void) | null = null
  let restored = 0
  const failed = () => {
    if (undo) return
    halt()
    drawingFailed('frame')
    undo = withoutDrawing(root, drawn, () => renew(true))
  }
  const gone = (event: Event) => {
    event.preventDefault()
    halt()
    // What the canvas drew is gone with its context: the printed hero stands in until a new one has.
    delete canvas.dataset.lit
    drawingFailed('lost')
    restored = window.setTimeout(() => renew(false), RESTORED_WITHIN_MS)
  }
  const back = () => renew(false)
  canvas.addEventListener('webglcontextlost', gone)
  canvas.addEventListener('webglcontextrestored', back)
  const guarded = new Proxy(renderer, {
    get(target, name) {
      try {
        const value = Reflect.get(target, name, target)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          try {
            return value.apply(target, args)
          } catch {
            failed()
          }
        }
      } catch {
        failed()
      }
    },
  })
  return {
    renderer: guarded,
    stop: () => {
      clearTimeout(restored)
      canvas.removeEventListener('webglcontextlost', gone)
      canvas.removeEventListener('webglcontextrestored', back)
      undo?.()
    },
  }
}

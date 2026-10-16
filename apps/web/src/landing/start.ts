// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Whether the chunk gets drawn, and on which canvas. A WebGL context can fail to start, or be
 * taken away and never given back (a busy graphics card, a switch between two of them, a tab left
 * in the background), and a canvas that lost its context keeps the lost one for good. So Chunk.tsx
 * is given a new canvas when that happens (`Canvas`, `nextCanvas`), a few times in a row at most,
 * and only after that does the page go on without the drawing (`withoutDrawing`). Not the drawing
 * itself, which is engine/gl.ts, nor what the page looks like without it, which is landing.css.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
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
export const RESTORED_WITHIN_MS = 2 * SECOND_MS

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

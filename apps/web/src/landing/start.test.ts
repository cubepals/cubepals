// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/** A drawing that fails to start gets a new canvas, and only a few failures in a row go without it. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type Canvas, FIRST_CANVAS, nextCanvas, withoutDrawing } from './start'

let frames: (() => void)[] = []
beforeEach(() => {
  frames = []
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => frames.push(() => callback(0))
  globalThis.cancelAnimationFrame = () => {}
})
afterEach(() => {
  frames = []
})

/** The page's root, as much of it as start.ts touches. */
const page = () => {
  const dataset: Record<string, string> = {}
  return { dataset, querySelectorAll: () => [] } as unknown as HTMLElement & {
    dataset: Record<string, string>
  }
}

/**
 * Chunk.tsx's start, run until it settles: each canvas asks for a context, which `refusals`
 * canvases in a row are refused, as a busy or just-reset graphics card refuses one.
 */
function start(root: HTMLElement, refusals: number, from: Canvas = FIRST_CANVAS) {
  let canvas = from
  let refused = 0
  for (;;) {
    if (refused >= refusals) return { canvas, drawn: true }
    refused++
    withoutDrawing(root, canvas, () => {
      canvas = nextCanvas(canvas, true)
    })
    const next = frames.shift()
    if (!next) return { canvas, drawn: false }
    next()
  }
}

describe('starting the drawing', () => {
  test('a context refused once is asked for again on a new canvas, and the chunk is drawn', () => {
    const root = page()
    const started = start(root, 1)
    expect(started.drawn).toBe(true)
    expect(started.canvas.key).toBe(1)
    expect(root.dataset.flat).toBeUndefined()
  })

  test('refused on every canvas, the page goes on without the drawing', () => {
    const root = page()
    const started = start(root, 10)
    expect(started.drawn).toBe(false)
    expect(started.canvas.key).toBe(2)
    expect(root.dataset.flat).toBe('true')
  })

  test('a canvas whose context was lost after drawing starts its count again', () => {
    const root = page()
    const twice = nextCanvas(nextCanvas(FIRST_CANVAS, true), true)
    expect(start(root, 1, nextCanvas(twice, false)).drawn).toBe(true)
    expect(root.dataset.flat).toBeUndefined()
  })

  test('going without the drawing is undone with the canvas', () => {
    const root = page()
    const undo = withoutDrawing(root, { key: 2, failed: 2 }, () => {})
    expect(root.dataset.flat).toBe('true')
    undo()
    expect(root.dataset.flat).toBeUndefined()
  })
})

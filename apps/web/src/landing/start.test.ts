// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/** A drawing that fails to start gets a new canvas, and only a few failures in a row go without it. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type Canvas, FIRST_CANVAS, keepDrawing, nextCanvas, withoutDrawing } from './start'

let frames: (() => void)[] = []
const { window: browser, clearTimeout: cleared } = globalThis
beforeEach(() => {
  frames = []
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => frames.push(() => callback(0))
  globalThis.cancelAnimationFrame = () => {}
})
afterEach(() => {
  globalThis.window = browser
  globalThis.clearTimeout = cleared
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

/** A canvas that can be told its context is lost or back, and the timers its page would run. */
function surface() {
  const listeners = new Map<string, (event: Event) => void>()
  const canvas = {
    dataset: { lit: '' },
    addEventListener: (name: string, run: (event: Event) => void) => listeners.set(name, run),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as HTMLCanvasElement
  const timers: (() => void)[] = []
  globalThis.window = {
    setTimeout: (run: () => void) => timers.push(run),
  } as unknown as Window & typeof globalThis
  globalThis.clearTimeout = () => {}
  return { canvas, listeners, timers }
}

describe('keeping the drawing from failing the page', () => {
  test('a renderer that throws ends the drawing instead, and what it returns otherwise comes through', () => {
    const root = page()
    const { canvas } = surface()
    const renewed: boolean[] = []
    let halted = 0
    const kept = keepDrawing(
      {
        width: 4,
        get ready(): boolean {
          throw new Error('link')
        },
        draw(): boolean {
          throw new Error('link')
        },
        resize: () => 'sized',
      },
      canvas,
      root,
      { key: 1, failed: 2 },
      (failed) => renewed.push(failed),
      () => halted++,
    )
    expect(kept.renderer.width).toBe(4)
    expect(kept.renderer.resize()).toBe('sized')
    expect(kept.renderer.ready).toBeUndefined()
    expect(kept.renderer.draw()).toBeUndefined()
    // Two canvases have failed before this one: it is the last, so the page goes flat, once.
    expect(halted).toBe(1)
    expect(root.dataset.flat).toBe('true')
    expect(renewed).toEqual([])
    kept.stop()
    expect(root.dataset.flat).toBeUndefined()
  })

  test('a renderer that throws on the first canvas is given a new one', () => {
    const root = page()
    const { canvas } = surface()
    const renewed: boolean[] = []
    const kept = keepDrawing(
      {
        draw(): boolean {
          throw new Error('link')
        },
      },
      canvas,
      root,
      FIRST_CANVAS,
      (failed) => renewed.push(failed),
      () => {},
    )
    kept.renderer.draw()
    kept.renderer.draw()
    frames.shift()?.()
    expect(renewed).toEqual([true])
    expect(root.dataset.flat).toBeUndefined()
  })

  test('a lost context stops the drawing, and a new canvas is made if it has not come back', () => {
    const { canvas, listeners, timers } = surface()
    const renewed: boolean[] = []
    let halted = 0
    const kept = keepDrawing(
      {},
      canvas,
      page(),
      FIRST_CANVAS,
      (failed) => renewed.push(failed),
      () => halted++,
    )
    const event = new Event('webglcontextlost', { cancelable: true })
    listeners.get('webglcontextlost')?.(event)
    expect(event.defaultPrevented).toBe(true)
    expect(halted).toBe(1)
    timers.shift()?.()
    expect(renewed).toEqual([false])
    kept.stop()
    expect(listeners.size).toBe(0)
  })
})

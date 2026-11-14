// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What serves the island to the page, and above all a lost WebGL context: it is said at once, so
 * the page shows its still again, nothing is drawn while it is gone, and the drawing is made again
 * on the same canvas, at the size last told, when it comes back. The drawing is stood in for (it
 * needs WebGL) and so is the worker's global, whose frames the test runs itself; what serves the
 * page is the real one, given a canvas that only raises events.
 */
import { describe, expect, test } from 'bun:test'
import type { Input } from './scene'
import { type Answer, type Drawn, type Scope, serve, type Told } from './serve'
import { STILL_MARKS } from './stills'

const INPUT: Input = { asked: 'leave', rise: 0, lean: [0, 0], still: false }

/** A drawing that is lit at once and has nothing to move, keeping the sizes it is given. */
const standing = (sizes: number[][]): Drawn => ({
  lit: true,
  frame: () => ({ power: 'sleeping', players: 0, busy: false }),
  marks: () => STILL_MARKS,
  resize: (width, height, ratio) => {
    sizes.push([width, height, ratio])
  },
  set() {},
  dispose() {},
})

/** The worker's global, its answers kept and its frames run only when the test says. */
function scoped() {
  const answers: Answer[] = []
  const frames = new Map<number, () => void>()
  let handles = 0
  const scope: Scope = {
    postMessage: (answer) => {
      answers.push(answer)
    },
    onmessage: null,
    requestAnimationFrame: (draw) => {
      handles += 1
      frames.set(handles, draw)
      return handles
    },
    cancelAnimationFrame: (handle) => {
      frames.delete(handle)
    },
  }
  const tell = (told: Told) => scope.onmessage?.({ data: told } as MessageEvent<Told>)
  /** Runs the frames asked for, and those they ask for, until the drawing rests. */
  const settle = () => {
    let turns = 0
    for (const [handle, draw] of frames) {
      turns += 1
      if (turns > 100) throw new Error('the drawing never rested')
      frames.delete(handle)
      draw()
    }
  }
  const shown = () => answers.filter((answer) => answer.kind === 'shown').length
  return { scope, answers, frames, tell, settle, shown }
}

describe('serving the island', () => {
  test('a lost context is said at once, and a restored one is drawn on again', () => {
    const { scope, answers, frames, tell, settle, shown } = scoped()
    const sizes: number[][] = []
    let made = 0
    serve(scope, () => {
      made += 1
      return standing(sizes)
    })
    const canvas = new EventTarget() as unknown as OffscreenCanvas
    tell({ kind: 'start', canvas, width: 565, height: 530, ratio: 2, input: INPUT })
    settle()
    expect(shown()).toBe(1)
    expect(made).toBe(1)

    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)
    expect(lost.defaultPrevented).toBe(true)
    expect(answers.at(-1)).toEqual({ kind: 'lost' })

    tell({ kind: 'size', width: 376, height: 353, ratio: 2 })
    expect(frames.size).toBe(0)

    canvas.dispatchEvent(new Event('webglcontextrestored'))
    settle()
    expect(shown()).toBe(2)
    expect(made).toBe(2)
    expect(sizes.at(-1)).toEqual([376, 353, 2])
  })
})

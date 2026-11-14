// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The worker's side of a lost WebGL context: it says so at once, so the page shows its still again,
 * and makes the drawing again on the same canvas when the context comes back. The scene is stood in
 * for (it needs WebGL); the worker itself is the real one, given a canvas that only raises events.
 */
import { describe, expect, mock, test } from 'bun:test'
import { until } from '@blockly/contracts/waits'
import type { Answer, Told } from './island.worker'
import { STILL_MARKS } from './stills'

let made = 0
class Standing {
  readonly lit = true
  constructor() {
    made += 1
  }
  resize() {}
  set() {}
  dispose() {}
  marks() {
    return STILL_MARKS
  }
  frame() {
    return { power: 'sleeping', players: 0, busy: false }
  }
}
mock.module('./scene', () => ({ Island: Standing }))

const answers: Answer[] = []
const global = globalThis as unknown as {
  postMessage: (answer: Answer) => void
  onmessage: ((event: { data: Told }) => void) | null
}
global.postMessage = (answer) => answers.push(answer)
await import('./island.worker')

const shownTimes = () => answers.filter((answer) => answer.kind === 'shown').length

describe('the island’s worker', () => {
  test('a lost context is said at once, and a restored one is drawn on again', async () => {
    const canvas = new EventTarget() as unknown as OffscreenCanvas
    const input = { asked: 'leave', rise: 0, lean: [0, 0], still: false } as const
    global.onmessage?.({ data: { kind: 'start', canvas, width: 565, height: 530, ratio: 2, input } })
    await until('the drawing to show', () => shownTimes() === 1)
    expect(made).toBe(1)

    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)
    expect(lost.defaultPrevented).toBe(true)
    expect(answers.at(-1)).toEqual({ kind: 'lost' })

    canvas.dispatchEvent(new Event('webglcontextrestored'))
    await until('the drawing to show again', () => shownTimes() === 2)
    expect(made).toBe(2)
  })
})

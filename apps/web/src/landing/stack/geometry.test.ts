// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The stack's drawing holds together for every print it can be drawn with: every word on a plate
 * stays on its plate (a mockup's address once ran past its edge, L-055), the parts over a read plate
 * rise clear of its whole top, and the island's print is always shown dot for dot.
 */
import { describe, expect, test } from 'bun:test'
import { SIZE } from '../engine/chunk'
import { bottomOf, PARTS, PLATES, type Print, stackOf, topOf } from './geometry'
import { poseOf, travelled } from './motion'
import { printFor } from './Stack'
import { NOTES, reachOf, topMarks } from './tops'

const RATIOS = [1, 1.25, 1.5, 2, 2.625, 3]
const ROOMS = [470, 400, 340]
const prints: Print[] = RATIOS.flatMap((ratio) => ROOMS.map((room) => printFor(room, ratio).print))

describe('the stack’s drawing', () => {
  test('every word on a plate stays on its plate, whatever the plans are called and keep', () => {
    const told = [
      { plus: 'Plus', kept: 14 },
      { plus: 'A plan with a long name', kept: 3 },
      { plus: null, kept: 30 },
    ]
    const marks = told.flatMap((one) =>
      PLATES.flatMap(({ part }) => topMarks(part, one).map((mark) => ({ part, mark }))),
    )
    for (const { part, mark } of marks) {
      if (mark.kind !== 'words') continue
      const within =
        mark.u >= 0.4 && reachOf(mark) <= SIZE - 0.4 && mark.v - mark.size >= 0.2 && mark.v <= SIZE - 0.2
      expect([part, mark.text, within]).toEqual([part, mark.text, true])
    }
    for (const { part, mark } of marks) {
      if (mark.kind !== 'box') continue
      const [u0, v0, u1, v1] = mark.at
      expect([part, Math.min(u0, v0) >= 0 && Math.max(u1, v1) <= SIZE]).toEqual([part, true])
    }
  })

  test('the parts over a read plate rise clear of its whole top, pulled out as it is', () => {
    for (const print of prints) {
      const stack = stackOf(print, { players: true, notes: NOTES })
      PARTS.forEach((part, k) => {
        if (k === 0) return
        const { lift, pull } = poseOf(stack, part)
        const back = stack.at([0, topOf(k), 0])
        const x = back[0] + stack.pull[0] * (pull[k] ?? 0)
        const y = back[1] + stack.pull[1] * (pull[k] ?? 0) - (lift[k] ?? 0)
        const front = stack.at([SIZE, bottomOf(k - 1), SIZE])
        const side = stack.at(x >= front[0] ? [SIZE, bottomOf(k - 1), 0] : [0, bottomOf(k - 1), SIZE])
        const edge =
          front[1] + (side[1] - front[1]) * ((x - front[0]) / (side[0] - front[0])) - (lift[k - 1] ?? 0)
        expect([part, print.unit, edge < y]).toEqual([part, print.unit, true])
      })
    }
  })

  test('the island’s print is shown dot for dot: two or three device pixels a dot, set on whole dots', () => {
    for (const ratio of RATIOS) {
      for (const room of ROOMS) {
        const { print } = printFor(room, ratio)
        expect([2, 3]).toContain(Math.round(print.unit * ratio * 1000) / 1000)
        const stack = stackOf(print, { players: true, notes: NOTES })
        expect(Number.isInteger(Math.round((stack.print.x / print.unit) * 1000) / 1000)).toBe(true)
        expect(Number.isInteger(Math.round((stack.print.y / print.unit) * 1000) / 1000)).toBe(true)
      }
    }
  })

  test('a Java player and a Bedrock player are drawn, where players are', () => {
    const print = printFor(470, 2).print
    const names = stackOf(print, { players: true, notes: NOTES }).players.map((player) => player.name)
    expect(names).toEqual(['java', 'bedrock'])
    expect(stackOf(print, { players: false, notes: null }).players).toEqual([])
  })

  test('a way travelled halfway stops halfway along it', () => {
    const line = [
      [0, 0],
      [10, 0],
      [10, 10],
    ] as const
    expect(travelled(line, 0.5)).toEqual({
      shown: [
        [0, 0],
        [10, 0],
      ],
      head: [10, 0],
    })
    expect(travelled(line, 0.75).head).toEqual([10, 5])
  })
})

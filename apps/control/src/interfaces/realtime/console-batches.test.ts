// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A tail's lines go out gathered, at most every BATCH_MS, and at most LINES_PER_SECOND of them a
 * second; what is left out is counted and said once that second is over. On a clock the test
 * moves, so nothing here waits on time.
 */
import { describe, expect, test } from 'bun:test'
import type { ConsoleLine } from '../../app/console/feed.ts'
import {
  BATCH_MS,
  type BatchClock,
  type ConsoleBatch,
  ConsoleBatcher,
  LINES_PER_SECOND,
} from './console-batches.ts'

/** A clock that moves only when the test says, running each timer that comes due on the way. */
function fakeClock() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: BatchClock = {
    now: () => now,
    setTimer: (callback, ms) => {
      nextId++
      timers.set(nextId, { at: now + ms, callback })
      return nextId
    },
    clearTimer: (id) => void timers.delete(id as number),
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort(([, a], [, b]) => a.at - b.at)[0]
      if (due === undefined) break
      timers.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = end
  }
  return { clock, advance, pending: () => timers.size }
}

const line = (n: number, at = new Date(1_700_000_000_000 + n)): ConsoleLine => ({
  at,
  text: `line ${n}`,
  level: 'info',
})

function batcher() {
  const { clock, advance, pending } = fakeClock()
  const sent: ConsoleBatch[] = []
  const batches = new ConsoleBatcher((batch) => sent.push(batch), { clock })
  return { batches, sent, advance, pending }
}

describe('a console tail', () => {
  test('sends the lines of a short burst together, once the batch is over', () => {
    const { batches, sent, advance } = batcher()
    for (let n = 0; n < 5; n++) batches.add(line(n))
    expect(sent).toEqual([])
    advance(BATCH_MS - 1)
    expect(sent).toEqual([])
    advance(1)
    expect(sent).toEqual([{ lines: [0, 1, 2, 3, 4].map((n) => line(n)), unshown: null }])
  })

  test('sends a quiet server’s one line within a batch, and nothing while it says nothing', () => {
    const { batches, sent, advance, pending } = batcher()
    batches.add(line(1))
    advance(BATCH_MS)
    expect(sent).toHaveLength(1)
    advance(5_000)
    expect(sent).toHaveLength(1)
    expect(pending()).toBe(0)
  })

  test('holds a flood of thousands of lines a second to ten messages and the cap, and says the rest', () => {
    const { batches, sent, advance } = batcher()
    // 20,000 lines a second for three seconds: twenty every millisecond.
    let n = 0
    for (let ms = 0; ms < 3_000; ms++) {
      for (let i = 0; i < 20; i++) batches.add(line(n++))
      advance(1)
    }
    batches.close()
    const shown = sent.reduce((sum, b) => sum + b.lines.length, 0)
    const unshown = sent.reduce((sum, b) => sum + (b.unshown?.count ?? 0), 0)
    expect(shown).toBe(3 * LINES_PER_SECOND)
    expect(shown + unshown).toBe(n)
    // About ten messages a second, and the count once a second.
    expect(sent.length).toBeLessThanOrEqual(3 * (1_000 / BATCH_MS) + 3)
    expect(sent.filter((b) => b.unshown !== null)).toHaveLength(3)
    // The count says when the last line left out was printed, so the page puts it in its place.
    expect(sent.at(-1)?.unshown?.at).toEqual(line(n - 1).at)
  })

  test('says the count once its second is over, even when nothing else comes', () => {
    const { batches, sent, advance } = batcher()
    for (let n = 0; n < LINES_PER_SECOND + 7; n++) batches.add(line(n))
    advance(BATCH_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.lines).toHaveLength(LINES_PER_SECOND)
    expect(sent[0]?.unshown).toBeNull()
    advance(1_000)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ lines: [], unshown: { count: 7, at: line(LINES_PER_SECOND + 6).at } })
  })

  test('lets lines through again in the next second', () => {
    const { batches, sent, advance } = batcher()
    for (let n = 0; n < LINES_PER_SECOND + 1; n++) batches.add(line(n))
    advance(1_000)
    batches.add(line(-1))
    advance(BATCH_MS)
    expect(sent.at(-1)?.lines).toEqual([line(-1)])
  })

  test('sends what it gathered, and the count, when the tail ends', () => {
    const { batches, sent, pending } = batcher()
    for (let n = 0; n < LINES_PER_SECOND + 2; n++) batches.add(line(n))
    batches.close()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.lines).toHaveLength(LINES_PER_SECOND)
    expect(sent[0]?.unshown?.count).toBe(2)
    expect(pending()).toBe(0)
  })
})

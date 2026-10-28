// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server list's line for a waking server: about how long is left of its measured wake, counted
 * from when the edge first saw it waking, and nothing it can't stand behind (`waking-line.ts`).
 */
import { describe, expect, test } from 'bun:test'
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { WAKING, WakingLine, wakingNotice } from './waking-line.ts'

describe('a waking server’s line', () => {
  test('says about how long is left of its measured wake, rounded as the server page rounds it', () => {
    expect(wakingNotice(2, 0)).toBe('Waking your world · about 2 seconds')
    expect(wakingNotice(1, 0)).toBe('Waking your world · about 1 second')
    expect(wakingNotice(37, 0)).toBe('Waking your world · about 40 seconds')
    expect(wakingNotice(37, 10 * SECOND_MS)).toBe('Waking your world · about 30 seconds')
    expect(wakingNotice(74, 0)).toBe('Waking your world · about 75 seconds')
    expect(wakingNotice(300, 0)).toBe('Waking your world · about 5 minutes')
  })

  test('says no time without a measurement, or once the wait runs past it', () => {
    expect(wakingNotice(undefined, 0)).toBe(WAKING)
    expect(wakingNotice(2, 2 * SECOND_MS)).toBe(WAKING)
    expect(wakingNotice(37, MINUTE_MS)).toBe(WAKING)
  })
})

describe('the line by hostname', () => {
  test('counts down from when this edge first saw the server waking', () => {
    let now = 1_000_000
    const line = new WakingLine('', () => now)
    expect(line.of('a.play.test', true, 37)).toBe('Waking your world · about 40 seconds')
    now += 20 * SECOND_MS
    expect(line.of('a.play.test', true, 37)).toBe('Waking your world · about 20 seconds')
    expect(line.of('b.play.test', true, 37)).toBe('Waking your world · about 40 seconds')
  })

  test('is null for a server that isn’t waking, and starts over at its next wake', () => {
    let now = 1_000_000
    const line = new WakingLine('', () => now)
    line.of('a.play.test', true, 37)
    now += 30 * SECOND_MS
    expect(line.of('a.play.test', false, 37)).toBeNull()
    expect(line.of('a.play.test', true, 37)).toBe('Waking your world · about 40 seconds')
  })

  test('a server that ran since counts its next wake down afresh, however soon it comes', () => {
    let now = 1_000_000
    const line = new WakingLine('', () => now)
    line.of('a.play.test', true, 37)
    line.of('b.play.test', true, 37)
    line.of('c.play.test', true, 37)
    now += 30 * SECOND_MS
    // The routes say a runs now and b still wakes; c is waking by a ping's ask alone.
    line.keep(
      [{ hostname: 'b.play.test', waking: true }, { hostname: 'a.play.test' }],
      (name) => name === 'c.play.test',
    )
    expect(line.of('a.play.test', true, 37)).toBe('Waking your world · about 40 seconds')
    expect(line.of('b.play.test', true, 37)).toBe('Waking your world · about 7 seconds')
    expect(line.of('c.play.test', true, 37)).toBe('Waking your world · about 7 seconds')
  })

  test('a wake its route never said had ended is forgotten after a while', () => {
    let now = 1_000_000
    const line = new WakingLine('', () => now)
    line.of('a.play.test', true, 37)
    now += 20 * MINUTE_MS
    expect(line.of('a.play.test', true, 37)).toBe('Waking your world · about 40 seconds')
  })

  test('says an operator’s own words when they are set', () => {
    const line = new WakingLine('Waking up · hold on')
    expect(line.of('a.play.test', true, 37)).toBe('Waking up · hold on')
    expect(line.of('a.play.test', false, 37)).toBeNull()
  })
})

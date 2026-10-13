// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The hand-over from one section's cast to the next: what was on thins away before the next comes
 * in, nothing is swapped in one frame, and going back is the same the other way.
 */
import { describe, expect, test } from 'bun:test'
import { Ground } from './ground.ts'
import { Handover } from './handover.ts'

const DT = 1 / 60

/** A clock the tests move on by a frame at a time. */
function clock() {
  let time = 0
  return () => {
    time += DT
    return time
  }
}

/** A hand-over and how much of the last box drawn through its grass was there. */
function made() {
  const seen = { solid: 1 }
  const handover = new Handover(
    (_x, _y, _z, _sx, _sy, _sz, _tone, _kind, _group, _inside, _round, _tipped, solid) => {
      seen.solid = solid ?? 1
    },
    new Ground(),
  )
  const look = () => {
    handover.grass(5, 1, 5, 0.5, 0.5, 0.5, 200, 1, 0, 0)
    return seen.solid
  }
  return { handover, look }
}

describe('a hand-over between sections', () => {
  test('what is on thins away first, and only then does the next come in', () => {
    const { handover, look } = made()
    let time = 0
    handover.step(time, null, null, false, false, false)
    let swappedAt = -1
    let last = look()
    for (let n = 0; n < 60; n++) {
      time += DT
      handover.step(time, 'friends', null, false, false, false)
      const solid = look()
      // Never more than a frame's share of the change at once.
      expect(Math.abs(solid - last)).toBeLessThan(0.1)
      if (swappedAt < 0 && handover.act === 'friends') {
        swappedAt = n
        expect(solid).toBe(0)
      }
      last = solid
    }
    expect(swappedAt).toBeGreaterThan(5)
    expect(look()).toBe(1)
  })

  test('scrolled back part-way, what was going comes back without the next ever showing', () => {
    const { handover, look } = made()
    const tick = clock()
    handover.step(0, null, null, false, false, false)
    for (let n = 0; n < 6; n++) handover.step(tick(), 'play', null, false, false, false)
    expect(look()).toBeLessThan(1)
    for (let n = 0; n < 60; n++) {
      handover.step(tick(), null, null, false, false, false)
      expect(handover.act).toBe(null)
    }
    expect(look()).toBe(1)
  })

  test('from too far off to make anyone out, the grass is swapped at once', () => {
    const { handover, look } = made()
    handover.step(0, null, null, false, false, false)
    handover.step(DT, 'friends', null, false, false, true)
    expect(handover.act).toBe('friends')
    expect(look()).toBe(1)
  })

  test('a room is only drawn while it is close enough to make out, and goes the same way', () => {
    const { handover } = made()
    const tick = clock()
    handover.step(0, null, 'edge', false, false, false)
    expect(handover.room).toBe(null)
    for (let n = 0; n < 60; n++) handover.step(tick(), null, 'edge', true, false, false)
    expect(handover.room).toBe('edge')
    handover.step(tick(), null, 'edge', false, false, false)
    expect(handover.room).toBe('edge')
    for (let n = 0; n < 60; n++) handover.step(tick(), null, 'edge', false, false, false)
    expect(handover.room).toBe(null)
  })

  test('with less motion asked for it is a shorter, plain fade', () => {
    const plain = made()
    const still = made()
    let time = 0
    plain.handover.step(time, null, null, false, false, false)
    still.handover.step(time, null, null, false, true, false)
    for (let n = 0; n < 12; n++) {
      time += DT
      plain.handover.step(time, 'knock', null, false, false, false)
      still.handover.step(time, 'knock', null, false, true, false)
    }
    expect(still.handover.act).toBe('knock')
    expect(plain.handover.act).toBe(null)
  })
})

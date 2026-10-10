// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The server kit's own behaviour: a rack takes and gives trays one at a time, boots, blinks,
 * stops at a fault and goes dark, stands as a frame of empty bays; and how the kit's pieces move.
 */
import { describe, expect, test } from 'bun:test'
import type { Box } from './models.ts'
import { chest, drop, lid, overshoot, type Place, Rack, Rider, slap, slip, UNIT, windup } from './server.ts'
import { Kind } from './world.ts'

interface Drawn {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  kind: number
  group: number
}

const HERE: Place = { x: 8, y: 0, z: 8, heading: 0, inside: 0 }
const near = (a: number, b: number) => Math.abs(a - b) < 0.004

function drawn(draw: (box: Box) => void): Drawn[] {
  const boxes: Drawn[] = []
  draw((x, y, z, sx, sy, sz, _tone, kind, group) => {
    boxes.push({ x, y, z, sx, sy, sz, kind, group })
  })
  return boxes
}
const trays = (boxes: Drawn[]) => boxes.filter((box) => near(box.sx, 1.84) && near(box.sz, 1.95)).length
const lamps = (boxes: Drawn[]) => boxes.filter((box) => box.kind === Kind.lamp && near(box.sx, 0.15)).length

describe('a server', () => {
  test('stands as tall as its trays', () => {
    const rack = new Rack(3)
    let top = 0
    drawn((box) => {
      top = rack.draw(box, HERE, 10)
    })
    expect(top).toBeCloseTo(3 * UNIT)
  })

  test('takes a tray at a time, and gives them back from the top', () => {
    const rack = new Rack(3)
    let clock = 10
    const frame = () => {
      clock += 1 / 60
      return drawn((box) => {
        rack.draw(box, HERE, clock)
      })
    }
    rack.size(5, clock)
    // Asked for two more, one is on its way and not yet there.
    expect(trays(frame())).toBe(3)
    for (let n = 0; n < 240; n++) {
      rack.size(5, clock)
      frame()
    }
    expect(trays(frame())).toBe(5)
    for (let n = 0; n < 360; n++) {
      rack.size(3, clock)
      frame()
    }
    expect(trays(frame())).toBe(3)
  })

  test('switched off, its lamps go out; switched on, they come back', () => {
    const rack = new Rack(3)
    const at = (clock: number) =>
      lamps(
        drawn((box) => {
          rack.draw(box, HERE, clock, true)
        }),
      )
    expect(at(10)).toBe(12)
    rack.set('off', 10)
    // Not all at once.
    expect(at(10.2)).toBeGreaterThan(0)
    expect(at(10.2)).toBeLessThan(12)
    expect(at(12)).toBe(0)
    rack.set('on', 12)
    expect(at(12.2)).toBeLessThan(12)
    expect(at(15)).toBe(12)
  })

  test('booting, its lamps come on from the bottom and are held lit', () => {
    const rack = new Rack(3, 5, 'off')
    const at = (clock: number) =>
      lamps(
        drawn((box) => {
          rack.draw(box, HERE, clock)
        }),
      )
    rack.set('booting', 10)
    expect(at(10.05)).toBeLessThan(4)
    // Held: every one of them, however long it is left booting.
    for (let clock = 12; clock < 30; clock += 0.37) expect(at(clock)).toBe(12)
    // Booted, it goes on to blink without going dark to boot again.
    rack.set('on', 30)
    expect(at(30.05)).toBeGreaterThan(0)
  })

  test('stopped by a fault, it flashes three times and stays dark', () => {
    const rack = new Rack(3)
    rack.set('fault', 10)
    const at = (clock: number) =>
      lamps(
        drawn((box) => {
          rack.draw(box, HERE, clock)
        }),
      )
    let flashes = 0
    let lit = false
    for (let clock = 10; clock < 11; clock += 1 / 120) {
      const now = at(clock) === 12
      if (now && !lit) flashes += 1
      lit = now
    }
    expect(flashes).toBe(3)
    for (let clock = 11; clock < 20; clock += 0.31) expect(at(clock)).toBe(0)
    // Switched off after it, there is nothing left to put out.
    rack.set('off', 20)
    expect(at(20.05)).toBe(0)
  })

  test('as a frame, its bays stand empty and trays go only into bays that stand', () => {
    const rack = new Rack(0, 5, 'off', 0, 0)
    let clock = 10
    let top = 0
    const frame = (bays: number, want: number) => {
      clock += 1 / 60
      rack.frame(bays, clock)
      rack.size(want, clock)
      return drawn((box) => {
        top = rack.draw(box, HERE, clock)
      })
    }
    // Nothing built: nothing drawn.
    expect(frame(0, 0).length).toBe(0)
    for (let n = 0; n < 240; n++) frame(4, 0)
    expect(top).toBeCloseTo(4 * UNIT)
    expect(trays(frame(4, 0))).toBe(0)
    for (let n = 0; n < 300; n++) frame(4, 3)
    expect(trays(frame(4, 3))).toBe(3)
    expect(top).toBeCloseTo(4 * UNIT)
    // Asked for more trays than bays, it takes what it has room for.
    for (let n = 0; n < 300; n++) frame(4, 5)
    expect(trays(frame(4, 5))).toBe(4)
    // Taken down, the trays come out before the bays sink.
    for (let n = 0; n < 60; n++) frame(0, 0)
    expect(top).toBeGreaterThan(3 * UNIT)
    for (let n = 0; n < 900; n++) frame(0, 0)
    expect(frame(0, 0).length).toBe(0)
  })

  test('at fault, every lamp flashes together', () => {
    const rack = new Rack(3)
    rack.set('fault', 10)
    const counts = new Set<number>()
    for (let n = 0; n < 60; n++)
      counts.add(
        lamps(
          drawn((box) => {
            rack.draw(box, HERE, 10 + n / 30)
          }),
        ),
      )
    expect([...counts].sort((a, b) => a - b)).toEqual([0, 12])
  })
})

describe('how the kit moves', () => {
  test('what is pushed home goes past and comes back', () => {
    let most = 0
    for (let t = 0; t <= 1; t += 0.01) most = Math.max(most, overshoot(t))
    expect(most).toBeGreaterThan(1.05)
    expect(overshoot(0)).toBeCloseTo(0)
    expect(overshoot(1)).toBeCloseTo(1)
  })

  test('what is taken away gathers itself first', () => {
    let least = 0
    for (let t = 0; t <= 1; t += 0.01) least = Math.min(least, windup(t))
    expect(least).toBeLessThan(-0.05)
    expect(windup(1)).toBeCloseTo(1)
  })

  test('what is dropped falls, bounces twice, and lies still', () => {
    expect(drop(0, 2).up).toBeCloseTo(2)
    expect(drop(0.36, 2).up).toBeCloseTo(0)
    expect(drop(0.5, 2).up).toBeGreaterThan(0.1)
    expect(drop(0.5, 2).jolt).toBeGreaterThan(0.5)
    expect(drop(2, 2)).toEqual({ up: 0, jolt: 0 })
  })

  test('a chest has a body, a latch and a lid', () => {
    expect(drawn((box) => chest(box, HERE)).length).toBe(3)
  })

  test('a lid thrown open goes a little past upright, and one let fall is shut at once', () => {
    let most = 0
    for (let t = 0; t <= 0.3; t += 0.01) most = Math.max(most, lid(true, t))
    expect(most).toBeGreaterThan(1.03)
    expect(lid(true, 5)).toBeCloseTo(1)
    expect(lid(false, 0)).toBeCloseTo(1)
    expect(lid(false, 0.15)).toBeCloseTo(0)
  })

  test('paper is slapped on past its size, and taken off it drops and is gone', () => {
    const wide = (on: number, off = -1) =>
      drawn((box) => slip(box, HERE, 0, 1.5, 0.4, 0.2, on, off))[0]?.sx ?? 0
    let most = 0
    for (let t = 0; t <= 0.2; t += 0.01) most = Math.max(most, wide(t))
    expect(most).toBeGreaterThan(0.42)
    expect(wide(5)).toBeCloseTo(0.4)
    const falling = drawn((box) => slip(box, HERE, 0, 1.5, 0.4, 0.2, 5, 0.3))[0]
    expect(falling?.y ?? 9).toBeLessThan(1.4)
    expect(wide(5, 3)).toBe(0)
    // The board it lands on shakes, and is still again.
    expect(Math.abs(slap(0.05))).toBeGreaterThan(0.3)
    expect(slap(1)).toBe(0)
  })

  test('the small world settles where it rides and never goes under its floor', () => {
    const world = new Rider()
    world.settle(1)
    world.bob -= 30
    let least = 9
    for (let n = 0; n < 600; n++) {
      world.step(1 / 60, 3, 1, 0.4)
      least = Math.min(least, world.ride)
    }
    expect(least).toBeGreaterThanOrEqual(1)
    expect(world.ride).toBeCloseTo(3, 1)
    expect(world.whirl).toBeCloseTo(0.4, 1)
  })
})

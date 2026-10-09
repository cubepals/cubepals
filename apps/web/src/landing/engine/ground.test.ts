/**
 * The ground under whoever is standing: a block somebody stands on is kept, with the ring round
 * it, and stops being kept when they have moved on.
 */
import { describe, expect, test } from 'bun:test'
import { Cast } from './cast.ts'
import { Ground } from './ground.ts'

describe('what is stood on', () => {
  test('a box resting on the grass keeps the block under it and the ring round that', () => {
    const ground = new Ground()
    // A shoe, on the grass at (5.3, 9.6).
    ground.rest(5.2, 1, 9.45, 0.25, 0.12, 0.3)
    expect(ground.has(5, 0, 9)).toBe(true)
    expect(ground.has(4, 0, 8)).toBe(true)
    expect(ground.has(6, 0, 10)).toBe(true)
    expect(ground.has(7, 0, 9)).toBe(false)
    // Only the level it stands on.
    expect(ground.has(5, -1, 9)).toBe(false)
    expect(ground.has(5, 1, 9)).toBe(false)
  })

  test('something in the air, or a flat thing lying on the floor, keeps nothing', () => {
    const ground = new Ground()
    ground.rest(5.2, 1.5, 9.45, 0.4, 0.4, 0.4)
    ground.rest(5.2, 1, 9.45, 1, 0.05, 0.14)
    expect(ground.has(5, 0, 9)).toBe(false)
  })

  test('it holds for one frame: when they have walked on, the block is free again', () => {
    const ground = new Ground()
    ground.rest(5.2, 1, 9.45, 0.25, 0.12, 0.3)
    ground.next()
    expect(ground.has(5, 0, 9)).toBe(false)
  })

  test('everyone the cast draws on the grass has ground kept under them', () => {
    const cast = new Cast()
    const ground = new Ground()
    for (let n = 0; n < 900; n++) {
      ground.next()
      const feet: [number, number][] = []
      cast.friendsStep(
        2,
        1 / 60,
        (x, y, z, sx, sy, sz) => {
          ground.rest(x, y, z, sx, sy, sz)
          // A body, most of a block tall, half a block wide: under its middle are its feet.
          if (Math.abs(sy - 0.72) < 0.004 && Math.abs(sx - 0.5) < 0.004) feet.push([x + sx / 2, z + sz / 2])
        },
        () => {},
        1,
      )
      for (const [x, z] of feet) expect(ground.has(Math.floor(x), 0, Math.floor(z))).toBe(true)
    }
  })
})

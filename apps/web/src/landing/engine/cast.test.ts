/**
 * Holds the cast to how people move: never more of them than a scene has, nobody within a block
 * of anybody, nobody sliding sideways or backwards, jumping, hurrying or spinning. Every scene on
 * the surface and every room under it is played for minutes and measured.
 */
import { describe, expect, test } from 'bun:test'
import { Cast, type Play } from './cast.ts'
import { ROOMS, type RoomKey } from './chunk.ts'

/**
 * What the page promises about how the people on the chunk move (README, "Who is in the
 * picture"), held to by running every scene for a long while with no browser:
 *
 *   - no two figures are ever nearer than a block apart;
 *   - nobody moves across the way they face, or backwards;
 *   - nobody goes faster than a stroll, and nobody gains or sheds pace in one frame;
 *   - nobody is suddenly somewhere else.
 *
 * A figure is found by its body with its head on it, and faces the way its body is turned.
 */
const SECONDS = 300
const DT = 1 / 60
/** A stroll, in blocks a second, with a little room for rounding. */
const FASTEST = 1.6
/** A fifth of a block a second, gained or lost in one frame, is the least that can be seen. */
const SHARPEST = 12

interface Raw {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  tone: number
  round: number
  solid: number
}

interface Seen {
  x: number
  y: number
  z: number
  face: [number, number]
  speed: number
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.004

/**
 * The figures in one frame's boxes: a whole head (a half-block cube) over a whole body (half a
 * block wide, most of one tall), which faces the way the body is turned.
 */
function figures(boxes: Raw[]): Seen[] {
  const heads = boxes.filter((box) => near(box.sx, 0.5) && near(box.sy, 0.5) && near(box.sz, 0.5))
  // (Someone who is thinning away, or not yet all there, is a ghost and not yet somebody.)
  const bodies = boxes.filter(
    (box) => box.solid > 0.9 && near(box.sx, 0.5) && near(box.sy, 0.72) && near(box.sz, 0.28),
  )
  const found: Seen[] = []
  for (const body of bodies) {
    const cx = body.x + body.sx / 2
    const cz = body.z + body.sz / 2
    // A body has a head on it (tipped a little, if it is looking down): a crate on a table has neither.
    const head = heads.find(
      (each) =>
        Math.abs(each.x + 0.25 - cx) < 0.3 &&
        Math.abs(each.z + 0.25 - cz) < 0.3 &&
        Math.abs(each.y - (body.y + 0.72)) < 0.06,
    )
    if (head)
      found.push({
        x: cx,
        y: body.y,
        z: cz,
        face: [Math.sin(body.round), Math.cos(body.round)],
        speed: Number.NaN,
      })
  }
  return found
}

interface Report {
  most: number
  nearest: number
  sideways: number
  backwards: number
  fastest: number
  sharpest: number
  jumps: number
}

type Box = (
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  tone: number,
  kind: number,
  group: number,
  inside: number,
  round?: number,
  tipped?: number,
  solid?: number,
) => void

function run(frame: (cast: Cast, time: number, box: Box) => void): Report {
  const cast = new Cast()
  const report: Report = {
    most: 0,
    nearest: Number.POSITIVE_INFINITY,
    sideways: 0,
    backwards: 0,
    fastest: 0,
    sharpest: 0,
    jumps: 0,
  }
  let before: Seen[] = []
  for (let n = 0; n < SECONDS / DT; n++) {
    const boxes: Raw[] = []
    frame(
      cast,
      n * DT,
      (x, y, z, sx, sy, sz, tone, _kind, _group, _inside, round = 0, _tipped = 0, solid = 1) => {
        boxes.push({ x, y, z, sx, sy, sz, tone, round, solid })
      },
    )
    const now = figures(boxes)
    report.most = Math.max(report.most, now.length)
    for (let a = 0; a < now.length; a++)
      for (let b = a + 1; b < now.length; b++) {
        const one = now[a] as Seen
        const other = now[b] as Seen
        // Someone hovering over someone else's head is not beside them.
        if (Math.abs(one.y - other.y) > 1.5) continue
        report.nearest = Math.min(report.nearest, Math.hypot(one.x - other.x, one.z - other.z))
      }
    for (const one of now) {
      // Whoever this was a frame ago: the nearest of them, if near enough to be the same person.
      let was: Seen | undefined
      let gap = Number.POSITIVE_INFINITY
      for (const old of before) {
        const far = Math.hypot(one.x - old.x, one.z - old.z, one.y - old.y)
        if (far < gap) {
          gap = far
          was = old
        }
      }
      if (was && gap < 0.3) {
        const dx = one.x - was.x
        const dz = one.z - was.z
        const moved = Math.hypot(dx, dz)
        one.speed = moved / DT
        report.fastest = Math.max(report.fastest, one.speed)
        // (Someone seen for the first time a frame ago had no pace to compare with.)
        if (!Number.isNaN(was.speed))
          report.sharpest = Math.max(report.sharpest, Math.abs(one.speed - was.speed) / DT)
        // A turn on the spot is a turn, and is not walking sideways: only steady facing is judged.
        const turned = Math.abs(was.face[0] - one.face[0]) + Math.abs(was.face[1] - one.face[1]) > 0.1
        if (moved > 0.0008 && !turned) {
          const along = (dx * one.face[0] + dz * one.face[1]) / moved
          const across = Math.abs(dx * one.face[1] - dz * one.face[0]) / moved
          if (across > 0.08) report.sideways += 1
          else if (along < 0) report.backwards += 1
        }
      } else if (was && gap < 3 && before.length === now.length) report.jumps += 1
    }
    before = now
  }
  return report
}

const none = () => {}

function holds(report: Report, people: number): void {
  expect(report.most).toBe(people)
  if (people > 1) expect(report.nearest).toBeGreaterThanOrEqual(1)
  expect(report.sideways).toBe(0)
  expect(report.backwards).toBe(0)
  expect(report.jumps).toBe(0)
  expect(report.fastest).toBeLessThanOrEqual(FASTEST)
  expect(report.sharpest).toBeLessThanOrEqual(SHARPEST)
}

describe('the people on the grass', () => {
  test('the first screen, round and round: two friends join a little apart, stay a while, and leave', () => {
    holds(
      run((cast, time, box) => {
        const into = time % 33
        const count = into < 2.4 ? 0 : into < 5.2 ? 1 : into < 18 ? 2 : into < 19.6 ? 1 : 0
        cast.friendsStep(count, DT, box, none, 1)
      }),
      2,
    )
  })

  test('the first screen, pressed impatiently: joins and leaves cut across each other', () => {
    holds(
      run((cast, time, box) => {
        const count = [0, 1, 2, 0, 2, 1, 2, 0, 1, 0][Math.floor(time / 2.7) % 10] as number
        cast.friendsStep(count, DT, box, none, 1)
      }),
      2,
    )
  })

  test('the closing: everyone is already at their place', () => {
    const report = run((cast, _time, box) => {
      cast.friendsStep(3, DT, box, none, 1, false, true)
    })
    holds(report, 3)
    expect(report.fastest).toBe(0)
  })

  test('what the closing put on the grass is gone when the page is back at the top', () => {
    const cast = new Cast()
    const seen = (count: number, settled: boolean) => {
      const boxes: Raw[] = []
      cast.friendsStep(
        count,
        DT,
        (x, y, z, sx, sy, sz, tone, _kind, _group, _inside, round = 0, _tipped = 0, solid = 1) => {
          boxes.push({ x, y, z, sx, sy, sz, tone, round, solid })
        },
        none,
        1,
        false,
        settled,
      )
      return figures(boxes).length
    }
    // The last scene: all three, at once, at their places.
    expect(seen(3, true)).toBe(3)
    for (let n = 0; n < 300; n++) seen(3, true)
    // Back at the top with the server asleep: nobody, and nobody filing out in the dark.
    expect(seen(0, false)).toBe(0)
    // And at the last scene again they are all there again.
    expect(seen(3, true)).toBe(3)
  })
})

describe('each way to play', () => {
  const people: Record<Play, number> = { survival: 2, hardcore: 3, smooth: 3, creative: 1, create: 1 }
  for (const play of Object.keys(people) as Play[])
    test(play, () => {
      holds(
        run((cast, _time, box) => {
          cast.playStep(play, DT, box, none, 1, false)
        }),
        people[play],
      )
    })

  test('in the order the tour goes, each for as long as the tour holds it', () => {
    const order: Play[] = ['survival', 'creative', 'creative', 'create']
    holds(
      run((cast, time, box) => {
        cast.playStep(order[Math.floor(time / 9) % order.length] as Play, DT, box, none, 1, false)
      }),
      2,
    )
  })
})

describe('the worker underground', () => {
  for (const room of ROOMS.map((each) => each.key) as RoomKey[])
    test(room, () => {
      holds(
        run((cast, _time, box) => {
          cast.roomStep(room, DT, box, none, false)
        }),
        // The gate and the sleep room have a friend who comes and goes, beside the worker.
        room === 'edge' || room === 'sleep' ? 2 : 1,
      )
    })
})

describe('the server under the house', () => {
  const drawn = (cast: Cast, play: Play, party: '5' | '10' | '20' | 'more', frames: number) => {
    let boxes: Raw[] = []
    for (let n = 0; n < frames; n++) {
      boxes = []
      cast.cellar(
        '',
        play,
        party,
        DT,
        (x, y, z, sx, sy, sz, tone, _kind, _group, _inside, round = 0, _tipped = 0, solid = 1) => {
          boxes.push({ x, y, z, sx, sy, sz, tone, round, solid })
        },
        false,
      )
    }
    return boxes
  }
  /** The trays of the rack: the pale ones, nearly two blocks deep and nearly as wide. */
  const trays = (boxes: Raw[]) => boxes.filter((box) => near(box.sx, 1.84) && near(box.sz, 1.95)).length

  test('it stands inside the vault, whatever was chosen', () => {
    for (const play of ['survival', 'creative', 'hardcore', 'smooth', 'create'] as Play[])
      for (const party of ['5', '10', '20', 'more'] as const)
        for (const box of drawn(new Cast(), play, party, 600)) {
          expect(box.x).toBeGreaterThanOrEqual(3)
          expect(box.x + box.sx).toBeLessThanOrEqual(16)
          expect(box.z).toBeGreaterThanOrEqual(1)
          expect(box.z + box.sz).toBeLessThanOrEqual(7)
          expect(box.y).toBeGreaterThanOrEqual(-8)
          // A turning piece of the small world reaches a little past its own box at the corners.
          expect(box.y + box.sy).toBeLessThanOrEqual(-1.4)
        }
  })

  test('it grows with the group, a tray at a time, and shrinks again', () => {
    const cast = new Cast()
    expect(trays(drawn(cast, 'survival', '5', 1))).toBe(3)
    // Asked for more, nothing arrives in a frame.
    expect(trays(drawn(cast, 'survival', '20', 1))).toBe(3)
    expect(trays(drawn(cast, 'survival', '20', 300))).toBe(5)
    expect(trays(drawn(cast, 'survival', '5', 300))).toBe(3)
  })
})

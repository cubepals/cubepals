// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The fleet: two of Blockly's own machines, the ledger between them, and the worker who keeps it.
 *
 * A machine here is a cabinet of four bays on a plinth, and a tray in a bay is memory in use. At
 * each machine's foot is its shelf: a chest for every world placed there. A shut chest with its
 * latch lit is a world asleep, which is its disk and nothing else, and it breathes. An open, empty
 * chest is a world awake: the world itself is up on top of the cabinet that runs it, turning, with
 * its trays in the bays under it. So a machine keeps more worlds than it could run at once.
 *
 * Between the two stands the ledger: a board with a column of slips for each machine, a slip for
 * every world awake there. A wire runs the floor from each machine to the board and to nowhere
 * else, and a pulse comes along each every 2.4 s: the heartbeat. The machines are not joined.
 *
 * One story: a world wakes, and its memory has to fit somewhere. The worker slaps a slip on the
 * board (the memory is claimed in the ledger before the machine is asked for anything), a pulse
 * runs from the board to that machine, a tray is pushed home and lights, and a chest's lid is
 * thrown open and its world springs up onto the cabinet. When that machine is full he lifts a copy
 * out of the chest beside him, carries it past the board to a new chest on the other shelf, and
 * wakes it there. When neither has room he looks at one full cabinet and then the other, and puts
 * up a notice. A world that sleeps drops back into its chest, its trays are pulled, and he takes
 * its slip off. He never touches a cabinet.
 *
 * It follows the section's demonstration, which says `turn` (how many presses have landed), `came`
 * (what the last one came to: 'woke', 'moved', 'refused', 'slept' or 'none'), for each machine
 * `Gb`, `Awake` and `Worlds` (memory held, worlds awake, chests on its shelf), and `cable` (how
 * the ledger reads the first machine's wire). Those are counts, so the room chooses which chest by
 * where it stands. A press is played as its beat of the story, one after another and never cut
 * short, so the room may trail the demonstration by a few seconds. Anything else (starting over, a
 * change with no press, more presses than can be acted out) is simply gone to: every part by its
 * own move, all together, with no hand in it. Joined part-way or held still, every part is as it
 * should be. Alone, it gives itself the tour's values on a clock.
 */
import { LIT } from '../chunk'
import { clamp, ease, lerp, wrap } from '../curves'
import type { Box } from '../models'
import {
  between,
  handsOf,
  type Point,
  PULSE,
  pulseIn,
  ROUND,
  type RoomScene,
  runIn,
  type View,
  wireIn,
  worker,
} from '../rooms'
import {
  board,
  chest,
  drop,
  overshoot,
  type Place,
  partsAt,
  puff,
  RACK_DEEP,
  RACK_WIDE,
  Rack,
  Rider,
  SETTLED,
  type Slot,
  slap,
  slip,
  slotsOf,
  smallWorld,
  spark,
  swung,
  UNIT,
  windup,
} from '../server'
import { type Body, bodyAt, headingOf, type Spot, turn, walk } from '../walk'
import { hash3, Kind } from '../world'

const QUARTER = Math.PI / 2

/** The two machines: the first at low u, whose cable can be cut, and the second. */
type Side = 0 | 1
const SIDES: readonly Side[] = [0, 1]
const across = (side: Side): Side => (side === 0 ? 1 : 0)

/**
 * Where things stand, in the room's terms. Each machine is a plinth with its cabinet on it, the
 * places for worlds awake along the cabinet's top (the first to wake furthest from the aisle), and
 * its shelf of chests out in front (the first place nearest the aisle).
 */
const CABINET = [1.9, 7.5] as const
const FACE = 2.7
const PLINTH = 1.5
const BAYS = 4
const TOP = PLINTH + BAYS * UNIT
/** How high a world's underside rides over the cabinet, on its spring. */
const RIDES = TOP + 0.15
const PERCHES = [
  [1.15, 1.65, 2.15, 2.65],
  [8.25, 7.75, 7.25, 6.75],
] as const
const PERCH = 1.75
const SHELVES = [
  [3.18, 2.54, 1.9, 1.26, 0.62],
  [6.22, 6.86, 7.5, 8.14, 8.78],
] as const
const SHELF = 4.15
/** The order a shelf's places fill in: along the floor from the aisle, then on top from the far end. */
const FILLS: readonly (readonly [number, number])[] = [0, 1, 2, 3].flatMap((tier) =>
  [0, 1, 2, 3, 4].map((n) => [tier === 0 ? n : 4 - n, tier] as const),
)
/** A chest here is the kit's at this size, and a small world goes in one at this size. */
const CHEST = 0.7
const CHEST_TALL = 0.9 * CHEST
const SMALL = 0.55
/** A world in a chest: how far in from the chest's front its middle is, and how high its underside. */
const BED = SHELF - 0.45 * CHEST
const BEDDED = 0.05
/** The ledger: the foot of its pole, its two columns, their four lines, and the strip for a notice. */
const LEDGER: Spot = [4.7, 3.5]
const COLUMNS = [4.47, 4.93] as const
const LINES = [1.5, 1.7, 1.9, 2.1] as const
const STRIP = 1.275
/**
 * Where the worker stands on each machine's side of the board, the board in reach of his arm. The
 * camera looks in from the high end of the room, so on that side he stands a little further off:
 * any nearer and his head is in front of the second machine's column.
 */
const STANDS: readonly [Spot, Spot] = [
  [3.9, 3.9],
  [5.7, 3.9],
]
/** Each machine's wire, from its plinth's side to the board's foot. */
const WIRES: readonly [readonly Spot[], readonly Spot[]] = [
  [
    [2.9, 2.2],
    [4.55, 2.2],
    [4.55, 3.4],
  ],
  [
    [6.5, 2.2],
    [4.85, 2.2],
    [4.85, 3.4],
  ],
]
/**
 * The first machine's wire with the piece a cut takes out of it, and where that piece lies: just
 * clear of the worker's legs, as the camera sees them from his place on that side.
 */
const STUB: readonly Spot[] = [
  [2.9, 2.2],
  [3.8, 2.2],
]
const REST: readonly Spot[] = [
  [4.2, 2.2],
  [4.55, 2.2],
  [4.55, 3.4],
]
const GAP: Point = [4, 2.2, 0]
const LOOSE: Point = [4.05, 2.75, 0]
/** How long a pulse takes from a plinth to the board, and how often one leaves each plinth. */
const TAKES = 2.85 / PULSE
const BEATS = 2.4
/** The middle of each cabinet's face: what a head turns to, to look at a machine. */
const FACES: readonly [Point, Point] = [
  [CABINET[0], FACE, PLINTH + 2 * UNIT],
  [CABINET[1], FACE, PLINTH + 2 * UNIT],
]
/** The walls a turn right round can go by: the open one, showing his face, and the back one. */
const OPEN = 0
const BACK = Math.PI

/** A world sprung up onto its cabinet is this long in the air. */
const SPRINGS = 0.5
/** A world going to sleep stops on its spring, hops off the cabinet and falls: by `LANDS` it is in its chest. */
const SLOWS = 0.08
const FALLS = 0.42
const HOPS = 0.87
const LANDS = SLOWS + FALLS
/** How long a world let go at a chest's rim takes to be in it. */
const LOWERS = 0.2
/** How far apart worlds, slips and chests follow one another when several go at once. */
const APART = 0.15
/**
 * A wake, in seconds from the worker's arm going up: the slip lands, the pulse leaves the board,
 * the first tray pops out, the chest is thrown open; and by `WAKES` the world is up and turning.
 */
const WAKE = [0.25, 0.45, 0.8, 1.3] as const
const WAKES = 2
/** His arms: holding a world at chest height, lowering it to a rim, and a hand out to a lid. */
const CARRIES = -1.05
const LOWERED = -0.7
const LIDDED = -1.3

type Came = 'none' | 'woke' | 'moved' | 'refused' | 'slept'
type Cable = 'up' | 'cut' | 'suspect' | 'unavailable' | 'lost' | 'back'
const CABLES: readonly string[] = ['cut', 'suspect', 'unavailable', 'lost', 'back']

interface Told {
  turn: number
  came: Came
  gb: readonly [number, number]
  awake: readonly [number, number]
  worlds: readonly [number, number]
  cable: Cable
}

/**
 * The round it plays alone, which is the tour: seconds in, `turn`, `came`, and each machine's
 * memory, worlds awake and chests. A move's own values come 0.8 s after it, as the tour's do.
 */
const ALONE: readonly (readonly [number, number, Came, number, number, number, number, number, number])[] = [
  [0, 0, 'none', 0, 0, 5, 0, 0, 4],
  [3, 1, 'woke', 8, 1, 5, 0, 0, 4],
  [7, 2, 'woke', 12, 2, 5, 0, 0, 4],
  [11, 3, 'woke', 15, 3, 5, 0, 0, 4],
  [15, 4, 'moved', 15, 3, 5, 0, 0, 4],
  [15.8, 4, 'moved', 15, 3, 5, 3, 1, 5],
  [22.5, 5, 'woke', 15, 3, 4, 11, 2, 5],
  [26.5, 6, 'woke', 15, 3, 4, 15, 3, 5],
  [30.5, 7, 'refused', 15, 3, 4, 15, 3, 5],
  [37.5, 8, 'slept', 7, 2, 4, 15, 3, 5],
  [42, 0, 'none', 0, 0, 5, 0, 0, 4],
]
const LAP = 45
/** It opens in the middle of the third wake: joined at that press, and played on this far. */
const OPENS = 11
const INTO = 1.2
/** The one held moment, for less motion: the move, the world in his hands half-way across. */
const HELD: Told = { turn: 4, came: 'moved', gb: [15, 0], awake: [3, 0], worlds: [5, 5], cable: 'up' }

/** A chest on a shelf, and the world that is its. */
interface Crate {
  /** Its place on the shelf, 0 nearest the aisle, and how many chests it stands on. */
  place: number
  tier: number
  /** There, or hopping away, and since when: one dropped in was let go `at`. */
  on: boolean
  at: number
  lid: Slot
  /** Its world: lying in it, up on the cabinet, or not come yet. */
  world: 'in' | 'up' | 'none'
  /** How that world last moved, and when. */
  how: 'still' | 'sprung' | 'dropped' | 'lowered'
  moved: number
  /** Its place on the cabinet's top; where hands let go of it; and how it lies in its chest. */
  perch: number
  from: readonly [number, number, number]
  turned: number
  /** The copy a move left behind: never started again, so its latch is dark and it doesn't breathe. */
  fenced: boolean
  /** Its latch is lit: a world is asleep in it. Since when, and when it last stopped. */
  latched: boolean
  slept: number
  roused: number
  /** The world's spring and turn on the cabinet, and how fast it comes to turn there. */
  rider: Rider
  turns: number
  seed: number
}

/** What is asked of a machine: each is let go at its own moment of a beat, and its parts go to it. */
interface Want {
  trays: number
  awake: number
  slips: number
  chests: number
}

interface Machine {
  rack: Rack
  crates: Crate[]
  /** The chests whose worlds are up on the cabinet, in the order they woke. */
  up: Crate[]
  slips: Slot[]
  want: Want
  /** The chest to open next, where a beat has said which. */
  next: Crate | null
  /** When a world last set off, a chest last came or went, a slip last moved, a pulse last left the board for it. */
  stirred: number
  shelved: number
  wrote: number
  asked: number
  /** How many trays it had a frame ago. */
  held: number
}

/** One beat of the story, for a press that has landed. */
interface Beat {
  kind: 'woke' | 'moved' | 'refused' | 'slept' | 'lost'
  /** The machine it is about: the one that wakes or sleeps a world; for a move, the one it goes to. */
  on: Side
  turn: number
  /** The values it delivers: as told at its press, and for a move as told since. */
  told: Told
  begun: boolean
  /** When it began, once the worker is where it needs him; how far it has got, and since when. */
  at: number | null
  stage: number
  since: number
  /** A move's two chests: the one the copy is lifted out of, and the one dropped in for it. */
  from: Crate | null
  into: Crate | null
}

/** What the worker is to do with himself this frame. */
interface Act {
  /** Where he is sent, if anywhere. */
  to: Spot | null
  /** Turned from the board to his own shelf and cabinet; and the wall a turn right round goes by. */
  away: boolean
  by: number
  /** His arms: the one on the back wall's side, which is the board's, and the one on the camera's. */
  back: number
  front: number
  /** How fast his arms move, in radians a second. */
  pace: number
  look: Point | null
}

const rest = (): Act => ({ to: null, away: false, by: OPEN, back: 0, front: 0, pace: 6, look: null })
const traysOf = (gb: number) => clamp(Math.ceil(gb / 4), 0, BAYS)
const wantOf = (told: Told, side: Side): Want => ({
  trays: traysOf(told.gb[side]),
  awake: told.awake[side],
  slips: told.awake[side],
  chests: told.worlds[side],
})
const same = (a: Told, b: Told) =>
  a.turn === b.turn &&
  a.came === b.came &&
  a.cable === b.cable &&
  SIDES.every((k) => a.gb[k] === b.gb[k] && a.awake[k] === b.awake[k] && a.worlds[k] === b.worlds[k])

export class FleetScene implements RoomScene {
  private readonly machines: readonly [Machine, Machine] = [machine(0), machine(1)]
  private readonly hand = bodyAt(STANDS[0], [1, 0])
  /** The side of the board he is on: the machine he last dealt with. */
  private side: Side = 0
  private was: Told | null = null
  /** The beats to play, the first of them under way; and values owed a plain going-to once they are done. */
  private beats: Beat[] = []
  private owed: Told | null = null
  /** The values came from somewhere else than last frame: whatever they say is simply gone to. */
  private jumped = false
  private alone = true
  private stilled = false
  private own = OPENS
  /** The notice of a refusal: up or not, since when, and when the last one was taken off. */
  private notice: Slot = { on: false, at: SETTLED }
  private shed = SETTLED
  /** The first machine declared lost: left as it is, a notice over its column, and its lamps out. */
  private lost = false
  private dark = false
  private voided: Slot = { on: false, at: SETTLED }
  /** The piece a cut takes out of the first machine's wire: out or not, and since when. */
  private cut: Slot = { on: false, at: SETTLED }
  /** The ledger hears the first machine. */
  private heard = true
  /** When the board was last slapped, and when he last looked the two machines over. */
  private shook = SETTLED
  private surveyed = SETTLED
  /** A copy in his hands: since when, and where in the room it popped up from. */
  private carried: number | null = null
  private lifted: Point | null = null
  /** His arms and head, each moved to where it is wanted and never put there. */
  private tool = 0
  private other = 0
  private gaze = 0
  private nod = 0
  /** The last thing that moved without him, for his head to turn to. */
  private seen: { at: number; to: Point } = { at: SETTLED, to: GAP }
  /** How a world lies square in its chest; and a number for each chest made, so each keeps its own time. */
  private square = 0
  private serial = 0

  step(view: View): void {
    const first = this.was === null
    this.square = view.facing(0)
    if (first && !view.showing && !view.still) {
      // Alone, it opens in the middle of things: as it stood at the third wake's press, and then
      // that beat played this far on, so the slip has landed and the fourth tray is on its way in.
      this.settle(aloneAt(OPENS - 0.01), view)
      for (let n = Math.round(INTO * 60) - 1; n >= 0; n--) {
        this.own += 1 / 60
        this.play(aloneAt(this.own), view, view.clock - n / 60, 1 / 60)
      }
    } else {
      const told = this.told(view)
      // Only changes are acted out; joined part-way or held still, every part is as it should be.
      const held = this.stilled && this.was !== null && same(told, this.was)
      if (first || view.still !== this.stilled || (view.still && !held)) this.settle(told, view)
      else if (!view.still) this.play(told, view, view.clock, view.dt)
    }
    this.stilled = view.still
    this.draw(view)
  }

  /** Everything as the values have it, with nothing on its way anywhere. */
  private settle(told: Told, view: View): void {
    const { clock } = view
    this.was = told
    this.beats = []
    this.owed = null
    this.jumped = false
    this.lost = told.cable === 'lost' || told.cable === 'back'
    this.dark = this.lost
    for (const k of SIDES) {
      const m = this.machines[k]
      m.want = wantOf(told, k)
      m.rack.settle(m.want.trays, k === 0 && this.lost ? 'off' : 'on', BAYS)
      m.held = m.want.trays
      // A shelf fills from its far end, and the first worlds to wake are the furthest from the aisle.
      m.crates = Array.from({ length: m.want.chests }, (_, n) => {
        const crate = this.crate(4 - (n % 5), Math.floor(n / 5), SETTLED)
        crate.latched = !(k === 0 && this.lost)
        crate.slept = clock - 30 - 5 * hash3(crate.seed, 5, 2)
        return crate
      })
      m.up = k === 0 && this.lost ? [] : m.crates.slice(0, m.want.awake)
      m.up.forEach((crate, n) => {
        crate.world = 'up'
        crate.perch = n
        crate.lid = { on: true, at: SETTLED }
        crate.latched = false
        crate.rider.settle(RIDES)
        crate.rider.spin = crate.seed * 1.3
        crate.rider.whirl = view.still ? 0 : crate.turns
      })
      m.slips = slotsOf(m.want.slips, LINES.length)
      m.next = null
      m.stirred = m.shelved = m.wrote = m.asked = SETTLED
    }
    this.notice = { on: told.came === 'refused', at: SETTLED }
    this.shed = SETTLED
    this.voided = { on: this.lost, at: SETTLED }
    this.cut = { on: told.cable !== 'up' && told.cable !== 'back', at: SETTLED }
    this.heard = told.cable === 'up' || told.cable === 'cut' || told.cable === 'suspect'
    this.shook = this.surveyed = SETTLED
    this.seen = { at: SETTLED, to: GAP }
    this.carried = this.lifted = null
    this.tool = this.other = this.gaze = this.nod = 0
    const hand = this.hand
    const board = this.side === 0 ? QUARTER : -QUARTER
    Object.assign(hand, bodyAt(STANDS[this.side], [Math.sin(board), 0]))
    if (told === HELD) {
      // The held moment: stopped in front of the board in mid-stride, the world in both hands,
      // and the new chest open and empty on the second shelf's nearest place.
      const into = this.machines[1].crates[4]
      if (into) {
        into.world = 'none'
        into.lid = { on: true, at: SETTLED }
        into.latched = false
      }
      Object.assign(hand, bodyAt([LEDGER[0], STANDS[0][1]], [1, 0]), { pace: ROUND, phase: QUARTER })
      this.side = 0
      this.carried = SETTLED
      this.tool = this.other = CARRIES
    }
  }

  /** Plays the room on by one frame: what the values ask, the beat under way, and every part's own move. */
  private play(told: Told, view: View, clock: number, dt: number): void {
    this.follow(told, clock)
    if (this.owed && this.beats.length === 0) {
      const owed = this.owed
      this.owed = null
      this.level(owed, clock)
    }
    const act = this.act(view, clock)

    // The worker goes where he is sent, in the one leg between his two places, and otherwise
    // turns on his spot: to the board, or away from it to his own shelf and cabinet.
    const hand = this.hand
    const board = this.side === 0 ? QUARTER : -QUARTER
    if (act.to) {
      if (walk(hand, act.to, ROUND, dt)) this.side = act.to === STANDS[0] ? 0 : 1
    } else {
      const final = act.away ? -board : board
      let off = wrap(final - hand.heading)
      // Right round, he goes by the wall he was told to; the short way only when it is plainly shorter.
      const way = Math.sign(wrap(act.by - hand.heading)) || 1
      if (off * way < -1.5) off += way * Math.PI * 2
      hand.want = Math.abs(off) > 2.6 ? hand.heading + way * 2.6 : final
      turn(hand, dt)
    }
    // Whichever arm is on the back wall's side is the one at the board.
    const toolBack = Math.sin(hand.heading) * view.handed > 0
    const pace = dt * act.pace
    this.tool += clamp((toolBack ? act.back : act.front) - this.tool, -pace, pace)
    this.other += clamp((toolBack ? act.front : act.back) - this.other, -pace, pace)
    const [gaze, nod] = act.look && !act.to ? headTo(hand, act.look, view.handed) : [0, 0]
    this.gaze += clamp(gaze - this.gaze, -dt * 5, dt * 5)
    this.nod += clamp(nod - this.nod, -dt * 3, dt * 3)

    for (const k of SIDES) this.tend(k, clock, dt)

    // The ledger hears the first machine again when a pulse has run the whole of its mended wire.
    const beat = heartbeat(0, clock)
    if (told.cable === 'up' && !this.heard && clock - this.cut.at > TAKES + 0.4)
      this.heard = beat >= TAKES && beat - dt < TAKES
    // A cut throws two chips up out of the floor with the piece.
    if (this.cut.on && clock - this.cut.at < dt) {
      const [x, y, z] = view.at(GAP[0], GAP[1])
      view.chips([x - 0.5, y, z - 0.5], [0, 0.6, 0], 2, 0.2)
    }
  }

  /** What changed in what the demonstration says, and what is to be made of it. */
  private follow(told: Told, clock: number): void {
    const was = this.was as Told
    if (same(told, was) && !this.jumped) return
    this.was = told
    const last = this.beats[this.beats.length - 1]
    if (told.turn === was.turn && !this.jumped) {
      // What follows a move's press 0.8 s later is what that beat delivers, so it starts nothing.
      if (last?.kind === 'moved' && last.turn === told.turn) last.told = told
      else this.owed = told
    } else {
      // One press on from the last, it is that press's beat, behind the one under way if there is
      // one. Anything more is too much to act out: the beat begun is finished and the rest gone to.
      const beat =
        told.turn === was.turn + 1 && !this.jumped && this.beats.length < 2
          ? beatOf(told, was, this.side)
          : null
      if (beat) {
        this.beats.push(beat)
        this.owed = null
      } else {
        this.beats.length = Math.min(this.beats.length, 1)
        this.owed = told
      }
    }
    this.jumped = false
    if (told.cable === was.cable) return
    const out = told.cable !== 'up' && told.cable !== 'back'
    if (out !== this.cut.on) this.cut = { on: out, at: clock }
    if (told.cable !== 'up' && told.cable !== 'cut' && told.cable !== 'suspect') this.heard = false
    if ((told.cable === 'lost' || told.cable === 'back') && !this.lost) {
      // Declared lost: from here the first machine is left as it is, and the worker says so on the board.
      this.lost = true
      this.beats.push({ ...beatAt('lost', 0, told), begun: true })
    }
  }

  /** Goes to what the values say with no beat: every part by its own move, all together. */
  private level(told: Told, clock: number): void {
    if (told.turn === 0) {
      // Starting over: the first machine is the ledger's again, and he looks the two over.
      if (this.lost) this.voided = { on: false, at: clock }
      this.lost = this.dark = false
      this.surveyed = clock
    }
    for (const k of SIDES) {
      if (k === 0 && this.lost) continue
      const m = this.machines[k]
      const want = wantOf(told, k)
      if (this.lost && want.awake > m.want.awake) {
        // A world rebuilt from its backup drops in as a chest, and is woken there as any world is.
        m.want.chests = want.chests
        this.beats.push(beatAt('woke', k, told))
      } else m.want = want
    }
    if (this.notice.on !== (told.came === 'refused')) this.post(told.came === 'refused', clock)
  }

  /** What the worker does this frame: the beat under way, or whatever there is to look at. */
  private act(view: View, clock: number): Act {
    const beat = this.beats[0]
    if (beat) {
      if (!beat.begun) this.begin(beat, clock)
      if (beat.kind === 'woke') return this.wake(beat, clock)
      if (beat.kind === 'moved') return this.move(beat, view, clock)
      if (beat.kind === 'refused') return this.refuse(beat, clock)
      if (beat.kind === 'slept') return this.sleep(beat, clock)
      return this.lose(beat, clock)
    }
    const act = rest()
    const cable = this.was?.cable
    if (clock - this.surveyed < 2.2) this.survey(act, clock - this.surveyed)
    else if (cable === 'unavailable') {
      // The ledger has lost the first machine: he turns to it and stands looking. That is all.
      act.away = this.side === 0
      act.by = BACK
      act.look = FACES[0]
    } else if (cable === 'cut' || cable === 'suspect') act.look = GAP
    else if (clock - this.seen.at < 1) act.look = this.seen.to
    return act
  }

  /**
   * A press's beat begins: an earlier refusal's notice comes down, and whatever the press changed
   * that is not this beat's to deliver is gone to at once. That is where a chest left behind by a
   * move hops and pops away.
   */
  private begin(beat: Beat, clock: number): void {
    beat.begun = true
    if (this.notice.on) this.post(false, clock)
    for (const k of SIDES) {
      if (k === 0 && this.lost) continue
      const m = this.machines[k]
      const want = wantOf(beat.told, k)
      if (beat.kind === 'refused' || k !== beat.on) m.want = want
      // (A move brings its own chest: here its shelf only loses what the press took away.)
      else m.want.chests = beat.kind === 'moved' ? Math.min(m.want.chests, want.chests) : want.chests
    }
  }

  /** A world wakes: slip, pulse, tray, and a chest thrown open. */
  private wake(beat: Beat, clock: number): Act {
    const act = rest()
    const k = beat.on
    const m = this.machines[k]
    if (beat.at === null) {
      // On the other side, he walks across first: the beat begins when he is at the board.
      if (!this.stands(k)) {
        act.to = STANDS[k]
        return act
      }
      if (!this.faces(k === 0 ? QUARTER : -QUARTER)) return act
      beat.at = clock
      beat.stage = 0
    }
    const t = clock - beat.at
    while (beat.stage < WAKE.length && t >= (WAKE[beat.stage] as number)) {
      // The memory is claimed in the ledger before the machine is asked for anything.
      if (beat.stage === 0) m.want.slips = beat.told.awake[k]
      else if (beat.stage === 1) m.asked = clock
      else if (beat.stage === 2) m.want.trays = traysOf(beat.told.gb[k])
      else {
        m.want.awake = beat.told.awake[k]
        m.next = beat.into
      }
      beat.stage += 1
    }
    if (t < 0.55) {
      act.back = reachOf(beat.told.awake[k])
      act.pace = 9
    }
    // His head follows the pulse to the machine, stays on it for the tray and the world, and is
    // back on the board by the end.
    if (t >= WAKE[1] && t < WAKE[2]) act.look = alongOf(k, (t - WAKE[1]) * PULSE)
    else if (t >= WAKE[2] && t < 1.8) act.look = t < WAKE[3] ? FACES[k] : perchOf(k, m.up.length - 1)
    if (t >= WAKES) this.beats.shift()
    return act
  }

  /**
   * The machine is full, so the world is moved: a copy out of the chest beside him, carried past
   * the board to a new chest on the other shelf, and woken there.
   */
  private move(beat: Beat, view: View, clock: number): Act {
    const act = rest()
    const to = beat.on
    const from = across(to)
    if (beat.at === null) {
      if (!this.stands(from)) {
        act.to = STANDS[from]
        return act
      }
      const near = this.sleepers(this.machines[from], clock).sort((a, b) => a.place - b.place)[0]
      if (!near) {
        // Nothing asleep there to carry: what the press came to is simply gone to.
        this.beats.shift()
        this.owed = beat.told
        return act
      }
      beat.at = clock
      beat.from = near
    }
    const t = clock - beat.at
    const src = beat.from as Crate
    const rim: Point = [SHELVES[from][src.place] ?? 0, BED, 0.5]
    if (beat.stage === 0) {
      // He looks up at the full cabinet, and turns round by way of it to the chest beside him.
      act.away = t >= 0.15
      act.by = BACK
      act.look = t < 0.45 ? FACES[from] : rim
      if (t >= 0.45) act.front = LIDDED
      if (t >= 0.6) {
        src.lid = { on: true, at: clock }
        beat.stage = 1
      }
    } else if (beat.stage === 1) {
      // A second world pops up out of the one in the chest, into both his hands.
      act.away = true
      act.front = LIDDED
      act.look = rim
      if (t >= 0.75) {
        this.carried = clock
        this.lifted = [rim[0], BED, BEDDED]
        beat.stage = 2
      }
    } else if (beat.stage === 2) {
      act.away = true
      act.back = act.front = t < 1 ? -0.8 : CARRIES
      act.look = rim
      if (t >= 1.25) beat.stage = 3
    } else if (beat.stage === 3) {
      // Round to the way he is going, by the open wall, so what he carries is seen.
      act.back = act.front = CARRIES
      if (this.faces(from === 0 ? QUARTER : -QUARTER)) {
        beat.stage = 4
        beat.since = clock
      }
    } else if (beat.stage === 4) {
      // One leg, past the front of the board. As he comes up to the other shelf a chest drops onto
      // its free place nearest him, and the landing throws its lid open.
      act.to = STANDS[to]
      act.back = act.front = CARRIES
      if (!beat.into && clock - beat.since >= 1.1) {
        const m = this.machines[to]
        beat.into = this.shelve(to, clock, true)
        m.want.chests = Math.max(beat.told.worlds[to], m.crates.filter((crate) => crate.on).length)
      }
      if (this.stands(to)) {
        beat.stage = 5
        beat.since = clock
      }
    } else if (beat.stage === 5) {
      // He lowers it to the new chest's rim and lets it go. Behind him the lid of the chest it was
      // copied from drops shut and its latch stays dark: that copy is never started again.
      const into = beat.into ?? this.shelve(to, clock, true)
      beat.into = into
      act.away = true
      act.back = act.front = LOWERED
      act.look = [SHELVES[to][into.place] ?? 0, BED, 0.5]
      if (clock - beat.since >= 0.2 && clock - into.at > 0.7) {
        const [x, y, z] = handsOf(view, this.hand, this.tool)
        into.world = 'in'
        into.how = 'lowered'
        into.moved = clock
        into.from = [x, y - 0.2, z]
        into.turned = this.square
        src.lid = { on: false, at: clock }
        src.fenced = true
        this.carried = this.lifted = null
        beat.stage = 6
        beat.since = clock
      }
    } else if (beat.stage === 6) {
      act.away = true
      act.look = [SHELVES[to][beat.into?.place ?? 0] ?? 0, BED, 0.5]
      if (clock - beat.since >= 0.25) beat.stage = 7
    } else if (this.faces(to === 0 ? QUARTER : -QUARTER)) {
      // Back at the board, it is woken on this machine as any world is, out of the chest he filled.
      beat.kind = 'woke'
      beat.at = clock
      beat.stage = 0
    }
    return act
  }

  /** Neither machine has room: he looks at one full cabinet, then the other, and puts up a notice. */
  private refuse(beat: Beat, clock: number): Act {
    const act = rest()
    if (beat.at === null) beat.at = clock
    if (beat.stage === 0) {
      this.survey(act, clock - beat.at)
      if (clock - beat.at >= 2 && this.faces(this.side === 0 ? QUARTER : -QUARTER)) {
        beat.stage = 1
        beat.since = clock
      }
      return act
    }
    const since = clock - beat.since
    if (beat.stage === 1 && since >= 0.25) {
      this.post(true, clock)
      beat.stage = 2
    }
    if (since < 0.55) {
      act.back = -1.4
      act.pace = 9
    }
    if (since >= 1) this.beats.shift()
    return act
  }

  /**
   * A world goes back to sleep. The machine goes first, with no hand in it: the world drops into
   * its chest and the trays are pulled. The ledger follows: he walks across if he is on the other
   * side, and takes the newest slip off.
   */
  private sleep(beat: Beat, clock: number): Act {
    const act = rest()
    const k = beat.on
    const m = this.machines[k]
    if (beat.at === null) beat.at = clock
    const t = clock - beat.at
    if (beat.stage === 0) {
      m.want.awake = beat.told.awake[k]
      beat.stage = 1
    }
    if (beat.stage === 1 && t >= 0.6) {
      m.want.trays = traysOf(beat.told.gb[k])
      beat.stage = 2
    }
    if (!this.stands(k)) {
      act.to = STANDS[k]
      return act
    }
    if (beat.stage === 2 && t >= 1.5 && this.faces(k === 0 ? QUARTER : -QUARTER)) {
      beat.stage = 3
      beat.since = clock
    }
    if (beat.stage < 3) {
      if (t < 1.5) act.look = FACES[k]
      return act
    }
    const since = clock - beat.since
    if (beat.stage === 3 && since >= 0.25) {
      m.want.slips = beat.told.awake[k]
      beat.stage = 4
    }
    if (since < 0.55) {
      act.back = reachOf(beat.told.awake[k] + 1)
      act.pace = 9
    }
    if (since >= 1.1) this.beats.shift()
    return act
  }

  /**
   * The first machine is declared lost. He slaps a notice over its column of the board; then its
   * cabinet goes dark from the top, its trays left in, and its worlds drop into their chests.
   */
  private lose(beat: Beat, clock: number): Act {
    const act = rest()
    const m = this.machines[0]
    if (beat.at === null) {
      if (!this.stands(0)) {
        act.to = STANDS[0]
        return act
      }
      if (!this.faces(QUARTER)) return act
      beat.at = clock
    }
    const t = clock - beat.at
    if (beat.stage === 0 && t >= 0.25) {
      this.voided = { on: true, at: clock }
      this.shook = clock
      beat.stage = 1
    }
    if (beat.stage === 1 && t >= 0.7) {
      m.rack.set('off', clock)
      m.want.awake = 0
      this.dark = true
      beat.stage = 2
    }
    if (t < 0.55) {
      act.back = -2.1
      act.pace = 9
    } else if (t >= 0.7) {
      act.away = true
      act.by = BACK
      act.look = FACES[0]
    }
    if (t >= 2.4) this.beats.shift()
    return act
  }

  /**
   * Looks the two machines over: the far one with his head, and then his own, which is behind
   * him, by turning round to it and back.
   */
  private survey(act: Act, t: number): void {
    act.by = BACK
    if (t < 0.6) act.look = FACES[across(this.side)]
    else if (t < 1.6) {
      act.away = true
      act.look = FACES[this.side]
    }
  }

  /** A machine's parts go to what is asked of them, each by its own move and one at a time. */
  private tend(k: Side, clock: number, dt: number): void {
    const m = this.machines[k]
    const dark = k === 0 && this.dark

    // Trays are pushed home and pulled one at a time. A cabinet that was dark is the ledger's
    // again once its last dark tray is out.
    m.rack.size(m.want.trays, clock)
    const trays = m.rack.trays
    if (trays !== m.held) this.seen = { at: clock, to: FACES[k] }
    m.held = trays
    if (!dark && m.rack.power === 'off' && m.rack.slots.every((slot) => !slot.on && clock - slot.at > 0.8))
      m.rack.set('on', clock)

    // Slips slap on from the bottom line up, and the newest drops off first.
    const written = m.slips.filter((slot) => slot.on).length
    if (written !== m.want.slips && clock - m.wrote >= APART) {
      const slot = m.slips[written < m.want.slips ? written : written - 1]
      if (slot) {
        slot.on = written < m.want.slips
        slot.at = clock
        m.wrote = this.shook = clock
      }
    }

    // A world wakes out of the chest a beat named, or one still standing open over a world set
    // down in it by hand, or else the shut one furthest from the aisle with nothing on it: its lid
    // is thrown open and it springs up onto the cabinet. The one that sleeps is the one that woke
    // last: it hops off and drops into its open chest.
    if (m.next && !(m.next.on && m.next.world === 'in')) m.next = null
    if (clock - m.stirred >= APART) {
      if (m.up.length < m.want.awake) {
        const crate =
          m.next ??
          m.crates.find((each) => each.on && each.world === 'in' && each.how === 'lowered' && each.lid.on) ??
          this.sleepers(m, clock).sort((a, b) => b.place - a.place)[0]
        if (crate && clock - crate.moved > LOWERS + 0.3) {
          crate.world = 'up'
          crate.how = 'sprung'
          crate.moved = clock
          crate.perch = m.up.length
          if (!crate.lid.on) crate.lid = { on: true, at: clock }
          crate.rider.spin = crate.turned
          crate.rider.whirl = 8
          m.up.push(crate)
          m.next = null
          m.stirred = clock
          this.seen = { at: clock, to: perchOf(k, crate.perch) }
        }
      } else if (m.up.length > m.want.awake) {
        const crate = m.up[m.up.length - 1]
        if (crate && clock - crate.moved > SPRINGS + 0.4) {
          m.up.pop()
          crate.world = 'in'
          crate.how = 'dropped'
          crate.moved = clock
          // It comes to lie square in its chest.
          crate.turned = this.square + Math.round((crate.rider.spin - this.square) / QUARTER) * QUARTER
          m.stirred = clock
          this.seen = { at: clock, to: perchOf(k, crate.perch) }
        }
      }
    }

    for (const crate of m.crates) {
      const age = clock - crate.moved
      if (crate.world === 'up') {
        // Sprung, it is caught by its spring where its arc ends, coming down onto it.
        if (crate.how === 'sprung' && age >= SPRINGS && age - dt < SPRINGS) {
          crate.rider.settle(RIDES)
          crate.rider.bob = -0.9
        }
        crate.rider.step(dt, RIDES, RIDES - 0.1, dark ? 0 : crate.turns)
      } else if (crate.world === 'in' && crate.how === 'dropped' && crate.lid.on && age >= LANDS + 0.22) {
        // In, and bounced: the lid falls shut over it.
        crate.lid = { on: false, at: clock }
      }
      // A latch is lit while a world is shut in asleep, and from then the chest breathes.
      const latched =
        crate.on &&
        crate.world === 'in' &&
        !crate.fenced &&
        !dark &&
        !crate.lid.on &&
        clock - crate.lid.at >= 0.15 &&
        clock - crate.at > 0.36
      if (latched !== crate.latched) {
        crate.latched = latched
        if (latched) crate.slept = clock
        else crate.roused = clock
      }
    }

    // A chest that is wanted drops onto the free place nearest the aisle. One that is not hops
    // and pops away, once every world is where it is going and shut in: the copy a move left
    // behind, or else a sleeper that stands on another, or else the sleeper nearest the aisle.
    const count = m.crates.filter((crate) => crate.on).length
    if (clock - m.shelved > 0.3) {
      if (count < m.want.chests) this.shelve(k, clock, false)
      else if (
        count > m.want.chests &&
        m.up.length === m.want.awake &&
        m.crates.every((crate) => !crate.on || crate.world === 'up' || bedded(crate, clock))
      ) {
        const spare =
          m.crates.find((crate) => crate.on && crate.fenced) ??
          this.sleepers(m, clock).sort((a, b) => b.tier - a.tier || a.place - b.place)[0]
        if (spare) {
          spare.on = false
          spare.at = m.shelved = clock
          this.seen = { at: clock, to: [SHELVES[k][spare.place] ?? 0, BED, 0.3] }
        }
      }
    }
    m.crates = m.crates.filter((crate) => crate.on || clock - crate.at < 0.4)
  }

  /** The shut chests on a shelf with a world asleep in them and nothing standing on them. */
  private sleepers(m: Machine, clock: number): Crate[] {
    return m.crates.filter(
      (crate) =>
        crate.on &&
        bedded(crate, clock) &&
        !crate.fenced &&
        !m.crates.some((over) => over.on && over.place === crate.place && over.tier > crate.tier),
    )
  }

  /**
   * Drops a chest onto a shelf: the free place nearest the aisle, or with the row full, on top of
   * the chest furthest from it. `empty`, it is for a world on its way in the worker's hands, and
   * its landing throws its lid open; otherwise it lands shut with a world asleep in it.
   */
  private shelve(k: Side, clock: number, empty: boolean): Crate {
    const m = this.machines[k]
    const taken = (place: number, tier: number) =>
      m.crates.some((crate) => crate.on && crate.place === place && crate.tier === tier)
    const free = FILLS.find(([place, tier]) => !taken(place, tier) && (tier === 0 || taken(place, tier - 1)))
    const crate = this.crate(free?.[0] ?? 0, free?.[1] ?? 0, clock)
    if (empty) {
      crate.world = 'none'
      crate.lid = { on: true, at: clock + 0.36 }
    }
    m.crates.push(crate)
    m.shelved = clock
    this.seen = { at: clock, to: [SHELVES[k][crate.place] ?? 0, BED, 0.3] }
    return crate
  }

  /** A chest for a shelf, shut, with a world in it. */
  private crate(place: number, tier: number, at: number): Crate {
    const seed = this.serial++
    return {
      place,
      tier,
      on: true,
      at,
      lid: { on: false, at: SETTLED },
      world: 'in',
      how: 'still',
      moved: SETTLED,
      perch: 0,
      from: [0, 0, 0],
      turned: this.square,
      fenced: false,
      latched: false,
      slept: SETTLED,
      roused: SETTLED,
      rider: new Rider(),
      turns: 0.34 + 0.14 * hash3(seed, 3, 5),
      seed,
    }
  }

  /** Slaps a refusal's notice onto the foot of the board, or takes it off. */
  private post(on: boolean, clock: number): void {
    this.notice = { on, at: clock }
    if (!on) this.shed = clock
    this.shook = clock
  }

  /** He is standing at his place on a machine's side of the board. */
  private stands(k: Side): boolean {
    return this.hand.x === STANDS[k][0] && this.hand.pace === 0
  }

  /** He has turned to face a way, and has stopped turning. */
  private faces(heading: number): boolean {
    return Math.abs(wrap(heading - this.hand.heading)) < 0.05 && Math.abs(this.hand.spin) < 0.4
  }

  /** Draws the room as it stands. */
  private draw(view: View): void {
    const { box, clock } = view
    const cable = this.was?.cable ?? 'up'

    // Warm light on the floor in front of the cabinet that took a tray last: it grows with the
    // trays whose lamps are on there, and goes with the last of them.
    let warm: Side = 0
    let latest = Number.NEGATIVE_INFINITY
    const lit: [number, number] = [0, 0]
    for (const k of SIDES) {
      const rack = this.machines[k].rack
      if (rack.power === 'off') continue
      for (const slot of rack.slots) {
        if (!slot.on || clock - slot.at < 0.7) continue
        lit[k] += 1
        if (slot.at + lit[k] * 0.001 > latest) {
          latest = slot.at + lit[k] * 0.001
          warm = k
        }
      }
    }
    view.light(CABINET[warm], 4.6, 1.2, 3, (0.8 * lit[warm]) / BAYS)

    for (const k of SIDES) {
      const m = this.machines[k]
      // The machine: a cobble plinth, which lifts the cabinet's whole face clear of the shelf in
      // front of it, and the cabinet of four bays on it.
      partsAt(box, view.place(CABINET[k], FACE))(
        0,
        PLINTH / 2,
        -RACK_DEEP / 2,
        RACK_WIDE,
        PLINTH,
        RACK_DEEP,
        150,
        Kind.cobble,
      )
      m.rack.draw(box, view.place(CABINET[k], FACE, PLINTH), clock, view.still)

      for (const crate of m.crates) {
        const u = SHELVES[k][crate.place] ?? 0
        const h = crate.tier * CHEST_TALL
        const stood = clock - crate.at
        if (!crate.on) {
          // Not wanted, it hops and pops away.
          const hop = 0.5 * Math.sin((stood / 0.4) * Math.PI)
          chest(box, view.place(u, SHELF, h + hop, 0, CHEST * (1 - windup(stood / 0.4))), 0, false)
          continue
        }
        // Dropped in, it bounces twice and its lid jumps with each landing; what lands in it
        // jolts the lid too.
        const landing = drop(stood, 1.9)
        const age = clock - crate.moved
        const fallen =
          crate.world !== 'in' || crate.how === 'still'
            ? -1
            : age - (crate.how === 'dropped' ? LANDS : crate.how === 'lowered' ? LOWERS : 0)
        const thump = fallen >= 0 ? drop(0.36 + fallen, 1) : { up: 0, jolt: 0 }
        const open = Math.max(landing.jolt * 0.25, swung(crate.lid, clock) * (1 - 0.25 * thump.jolt))
        const stands = view.place(u, SHELF, h + landing.up, 0, CHEST)
        chest(box, stands, open, crate.latched)
        // (Held still there is nothing in the air, and a puff is in the air.)
        if (!view.still && (crate.latched || clock - crate.roused < 0.25))
          sigh(box, stands, clock - crate.slept - 1.2, crate.latched ? -1 : clock - crate.roused, crate.seed)

        // Its world: up on the cabinet on its spring, on its way there or back in one arc, or
        // lying in the chest, where it shows over the rim while the lid is up.
        const bed: Point = [u, BED, h + BEDDED]
        const perch = perchOf(k, crate.perch)
        const { spin, ride } = crate.rider
        if (crate.world === 'up' && crate.how === 'sprung' && age < SPRINGS) {
          // Up and then back over the cabinet's edge, a third of a block past its height.
          const through = age / SPRINGS
          const rise = overshoot(through)
          const at = between(bed, perch, ease(through), Math.min(1, rise))
          small(view, [at[0], at[1], at[2] + Math.max(0, rise - 1) * 3.3], spin)
        } else if (crate.world === 'up' || (crate.how === 'dropped' && age < SLOWS)) {
          small(view, [perch[0], perch[1], ride], spin)
        } else if (crate.world !== 'in') continue
        else if (crate.how === 'dropped' && age < LANDS) {
          // A hop up off the cabinet and out over its edge, and then down into the open chest.
          const through = (age - SLOWS) / FALLS
          small(
            view,
            between(
              [perch[0], perch[1], ride],
              bed,
              1 - (1 - through) ** 2,
              (1 + HOPS) * through * through - HOPS * through,
            ),
            lerp(spin, crate.turned, through),
          )
        } else if (crate.how === 'lowered' && age < LOWERS) {
          // Let go at the rim, it falls the rest of the way in.
          const [x, y, z] = view.at(bed[0], bed[1], bed[2])
          const fall = age / LOWERS
          smallWorld(
            box,
            {
              x: lerp(crate.from[0], x, fall),
              y: lerp(crate.from[1], y, fall * fall),
              z: lerp(crate.from[2], z, fall),
              heading: crate.turned,
              inside: view.inside,
              scale: SMALL,
            },
            'survival',
            clock,
          )
        } else if (open > 0.35) small(view, [bed[0], bed[1], bed[2] + thump.up * CHEST], crate.turned)
      }
    }

    // The ledger. Each column's slips from the bottom line up; a refusal's notice across its
    // foot; over the first column, once that machine is lost, a notice that covers its slips.
    // On its top edge two lamps: each machine's heartbeat as the ledger hears it.
    const ledger = view.place(LEDGER[0], LEDGER[1])
    board(box, ledger, 0.9, 1.2, 1.1, slap(clock - this.shook))
    const covered = this.voided.on && clock - this.voided.at > 0.1
    for (const k of SIDES) {
      const x = (COLUMNS[k] - LEDGER[0]) * view.handed
      this.machines[k].slips.forEach((slot, n) => {
        if (k === 0 && covered) return
        const since = clock - slot.at
        slip(box, ledger, x, LINES[n] ?? 0, 0.36, 0.14, since, slot.on ? -1 : since)
      })
      const heard =
        k === 1 || (this.heard && (cable !== 'suspect' || view.still || Math.floor(clock * 4) % 2 === 0))
      // A lamp jumps as each pulse lands at the board's foot.
      const landed = heartbeat(k, clock) - TAKES
      const lands = heard && (k === 1 || cable === 'up')
      const jump =
        !view.still && lands && landed >= 0 && landed < 0.2 ? Math.sin((landed / 0.2) * Math.PI) : 0
      const size = 0.14 * (1 + 0.5 * jump)
      partsAt(box, ledger)(
        x,
        2.3 + size / 2,
        0,
        size,
        size,
        size,
        heard ? 80 : 60,
        heard ? Kind.lamp : Kind.dark,
        heard ? LIT : 0,
      )
    }
    const posted = clock - this.notice.at
    if (this.notice.on) slip(box, ledger, 0, STRIP, 0.8, 0.22, posted)
    slip(box, ledger, 0, STRIP, 0.8, 0.22, 0, clock - this.shed)
    const voided = clock - this.voided.at
    slip(
      box,
      ledger,
      (COLUMNS[0] - LEDGER[0]) * view.handed,
      1.8,
      0.4,
      0.8,
      voided,
      this.voided.on ? -1 : voided,
    )

    // The wires, dark but for what is on its way along them. The heartbeat leaves each plinth's
    // foot for the board; a wake's pulse runs the other way. A cut takes a piece out of the first
    // machine's wire: it pops up and lies askew beside the gap, and that machine's pulses die
    // there in a spark until it hops back in and is pressed flat.
    const loose = clock - this.cut.at
    const mended = !this.cut.on && loose >= 0.3
    if (mended) wireIn(view, WIRES[0])
    else {
      wireIn(view, STUB)
      wireIn(view, REST)
      const out = this.cut.on ? clamp(loose / 0.35) : 1 - clamp(loose / 0.3)
      const [u, v, lift] = between(GAP, LOOSE, out, out)
      partsAt(box, view.place(u, v, lift + 0.55 * 4 * out * (1 - out), QUARTER + 0.6 * out))(
        0,
        0.025,
        0,
        0.14,
        0.05,
        0.54,
        40,
        Kind.dark,
      )
    }
    if (!this.cut.on) {
      const [x, y, z] = view.at(GAP[0], GAP[1])
      spark(box, x, y, z, loose - 0.3, view.inside)
    }
    wireIn(view, WIRES[1])
    if (view.still) {
      // Held still, nothing travels; with nothing published, one pulse is part-way along each wire.
      if (!view.showing) for (const k of SIDES) pulseIn(view, WIRES[k], 0.45)
    } else {
      if (cable !== 'lost') {
        if (mended) runIn(view, WIRES[0], heartbeat(0, clock))
        else runIn(view, STUB, heartbeat(0, clock), true)
      }
      runIn(view, WIRES[1], heartbeat(1, clock))
      for (const k of SIDES) runIn(view, [...WIRES[k]].reverse(), clock - this.machines[k].asked)
    }

    // The worker, and the copy in his hands: it pops up out of the world in the chest he is at,
    // a little past his hands and back, and goes where they go.
    const hand = this.hand
    const armed = Math.abs(this.tool) > 0.02 || Math.abs(this.other) > 0.02
    worker(
      view,
      hand,
      armed
        ? { tool: this.tool, other: this.other, gaze: this.gaze, nod: this.nod }
        : { gaze: this.gaze, nod: this.nod },
    )
    if (this.carried !== null) {
      const held = clock - this.carried
      const [hx, hy, hz] = handsOf(view, hand, this.tool)
      const from = this.lifted
      const [ax, ay, az] = from ? view.at(from[0], from[1], from[2]) : [hx, hy - 0.2, hz]
      const up = overshoot(clamp(held / 0.2))
      smallWorld(
        box,
        {
          x: lerp(ax, hx, up),
          y: lerp(ay, hy - 0.2, up),
          z: lerp(az, hz, up),
          heading: view.facing(hand.heading),
          inside: view.inside,
          scale: SMALL * clamp(held / 0.08, 0.3),
        },
        'survival',
        clock,
      )
    }
  }

  /** What the demonstration says, or, alone, the tour's own values on a clock. */
  private told(view: View): Told {
    const said = view.showing
    if (said) {
      if (this.alone) this.jumped = true
      this.alone = false
      const came = String(said.came)
      const cable = String(said.cable)
      const count = (value: unknown, most: number) => clamp(Math.round(Number(value) || 0), 0, most)
      return {
        turn: Number(said.turn) || 0,
        came: came === 'woke' || came === 'moved' || came === 'refused' || came === 'slept' ? came : 'none',
        gb: [Number(said.aGb) || 0, Number(said.bGb) || 0],
        awake: [count(said.aAwake, BAYS), count(said.bAwake, BAYS)],
        worlds: [count(said.aWorlds, 12), count(said.bWorlds, 12)],
        cable: CABLES.includes(cable) ? (cable as Cable) : 'up',
      }
    }
    if (view.still) return HELD
    // Handed back by the demonstration, or let go from a held moment, it starts its round over.
    if (!this.alone || this.stilled) {
      this.jumped = true
      this.own = 0
    }
    this.alone = true
    this.own += view.dt
    return aloneAt(this.own)
  }
}

/** A chest has landed and its world is shut in it, with nothing still moving. */
const bedded = (crate: Crate, clock: number) =>
  crate.world === 'in' && !crate.lid.on && clock - crate.lid.at > 0.3 && clock - crate.at > 0.9

/** A machine with nothing on it yet: an empty cabinet and a bare shelf. */
function machine(k: Side): Machine {
  return {
    rack: new Rack(0, BAYS, 'on', k + 1, BAYS),
    crates: [],
    up: [],
    slips: slotsOf(0, LINES.length),
    want: { trays: 0, awake: 0, slips: 0, chests: 0 },
    next: null,
    stirred: SETTLED,
    shelved: SETTLED,
    wrote: SETTLED,
    asked: SETTLED,
    held: 0,
  }
}

/** A beat, not yet begun. */
const beatAt = (kind: Beat['kind'], on: Side, told: Told): Beat => ({
  kind,
  on,
  turn: told.turn,
  told,
  begun: false,
  at: null,
  stage: 0,
  since: 0,
  from: null,
  into: null,
})

/**
 * The beat a press came to, read off what it changed: a wake or a sleep is on the machine whose
 * worlds awake went up or down, and a move goes from the machine holding more memory to the other.
 */
function beatOf(told: Told, was: Told, side: Side): Beat | null {
  if (told.came === 'none') return null
  const on =
    told.came === 'woke'
      ? SIDES.find((k) => told.awake[k] > was.awake[k])
      : told.came === 'slept'
        ? SIDES.find((k) => told.awake[k] < was.awake[k])
        : told.came === 'moved'
          ? across(told.gb[0] >= told.gb[1] ? 0 : 1)
          : side
  return on === undefined ? null : beatAt(told.came, on, told)
}

/** The values the room gives itself, this many seconds into playing alone. */
function aloneAt(own: number): Told {
  const t = own % LAP
  const row = ALONE.filter((each) => each[0] <= t).pop() as (typeof ALONE)[number]
  const [, turn, came, aGb, aAwake, aWorlds, bGb, bAwake, bWorlds] = row
  return { turn, came, gb: [aGb, bGb], awake: [aAwake, bAwake], worlds: [aWorlds, bWorlds], cable: 'up' }
}

/**
 * How long ago a machine's last heartbeat left its plinth. The two are 1.2 s apart, and the
 * second machine's is on its way along its wire on the room's first frame.
 */
const heartbeat = (k: Side, clock: number) => (clock + 2 * BEATS + (k === 0 ? 1.35 : 0.15)) % BEATS

/** A place on a cabinet's top where a world rides. */
const perchOf = (k: Side, n: number): Point => [PERCHES[k][clamp(n, 0, 3)] ?? 0, PERCH, RIDES]

/** How far up his arm goes to reach a line of the board, counted from the bottom line. */
const reachOf = (line: number) => -1.55 - 0.25 * clamp(line, 1, LINES.length)

/** Where a wake's pulse is, this far along a machine's wire from the board's foot. */
function alongOf(k: Side, far: number): Point {
  const [foot, corner, end] = WIRES[k] as [Spot, Spot, Spot]
  const down = Math.abs(end[1] - corner[1])
  if (far < down) return [end[0], end[1] - far, 0]
  return [corner[0] + Math.sign(foot[0] - corner[0]) * Math.min(far - down, 1.65), corner[1], 0]
}

/** A small world at a place in the room: the middle of its underside, and how it is turned. */
function small(view: View, at: Point, heading: number): void {
  const [x, y, z] = view.at(at[0], at[1], at[2])
  smallWorld(view.box, { x, y, z, heading, inside: view.inside, scale: SMALL }, 'survival', view.clock)
}

/**
 * How a head must turn and tip to look at a place in the room, from where its body stands and the
 * way that faces: no further round than a neck goes.
 */
function headTo(body: Body, to: Point, handed: number): [number, number] {
  const du = to[0] - body.x
  const dv = to[1] - body.z
  const round = wrap(headingOf([du, dv]) - body.heading)
  // Looking over his shoulder at what is behind him, it tips half as far: a head turned right
  // round and tipped right down looks broken.
  const tip = Math.atan2(1.7 - to[2], Math.hypot(du, dv)) * (Math.abs(round) > 1.15 ? 0.5 : 1)
  return [clamp(round, -1.15, 1.15) * handed, clamp(tip, -0.5, 0.5)]
}

/**
 * Kit candidate: the slow breath with a beginning and an end. The kit's slow `breath` keeps time
 * by the room's clock alone, so a chest that has just been shut would be found with a puff
 * already half-way up, and one thrown open would lose its puff in mid-air. Here `since` is seconds
 * since the chest began to breathe, so its first puff leaves the lid then; each chest keeps its
 * own time after that (`seed`); and `over` is seconds since it stopped (negative while it goes
 * on), when the puff in the air pops away. One puff at a time, at half the kit's size, rising
 * straight up from the middle of the lid.
 */
function sigh(box: Box, at: Place, since: number, over: number, seed: number): void {
  if (since < 0 || over > 0.25) return
  const age = (since % (4.4 + 1.2 * hash3(seed, 7, 1))) / 2
  if (age >= 1) return
  const size = (0.12 + age * 0.2) * 0.72 * puff(age) * (over > 0 ? 1 - windup(over / 0.25) : 1)
  if (size > 0.02) partsAt(box, at)(0.08 * age, 1 + age * 0.75, -0.45, size, size, size, 250, Kind.wool)
}

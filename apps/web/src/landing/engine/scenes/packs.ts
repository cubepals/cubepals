/**
 * Modpacks: one pack, one server, one worker.
 *
 * The pack is one chest, and what is in it is jars: small crates, each with a lamp in its face.
 * The worker stands between the chest and the lever and never leaves that spot. The chest drops
 * in; its lid is thrown open and it is read; then jar after jar pops up into the worker's hands
 * and is either sprung onto the stack beside the server or dropped back into the chest, for
 * players' games alone. Then the lever: the server starts, stops with every lamp flashing, and
 * one jar in the stack jumps and smokes. That one is taken back out, read, and dropped into the
 * chest with the rest; the lever is pulled again, the lamps stay on, each jar's lamp is lit in
 * turn, and the world lifts off the rack.
 *
 * It follows the section's demonstration, which says: `kind` (which file was dropped), `read`,
 * `gate` (a jar is being looked at), `kept` and `left` (how many went each way), `power` ('off',
 * 'starting', 'fault' or 'online') and `stamped` (how many installed jars have been checked).
 * Every part's state follows from those, so the scene can be joined at any moment; only changes
 * are acted out. Left alone it gives itself the same values on a clock.
 */
import { LIT } from '../chunk'
import { clamp, lerp } from '../curves'
import { flight, type Point, type RoomScene, runIn, type View, wireIn, worker } from '../rooms'
import {
  chest,
  drop,
  jar,
  lever,
  overshoot,
  Rack,
  Rider,
  SETTLED,
  smallWorld,
  smoke,
  windup,
} from '../server'
import { bodyAt, headingOf, reach, type Spot, turn } from '../walk'
import { Kind } from '../world'

/** Where things stand, in the room's terms: one row at one depth, facing the open wall. */
const RACK: Spot = [7.2, 3.1]
const CHEST: Spot = [3.7, 3.1]
const WORKER: Spot = [2.65, 2.65]
const LEVER: Spot = [2.65, 3.45]
const WIRE: readonly Spot[] = [
  [2.85, 3.45],
  [7.2, 3.45],
  [7.2, 3.15],
]
/** The stack beside the server: along the floor from the rack outward, and then on top of those. */
const PLACES: readonly Point[] = [
  [5.75, 2.85, 0],
  [5.25, 2.85, 0],
  [4.75, 2.85, 0],
  [5.75, 2.85, 0.5],
  [5.25, 2.85, 0.5],
  [4.75, 2.85, 0.5],
]
/** A jar in the worker's hands, and one just inside the chest's mouth. */
const HANDS: Point = [3.55, 2.65, 0.95]
const MOUTH: Point = [3.7, 2.65, 0.3]
/** How long a jar is in the air, how high over a straight line it goes, and how long one falls. */
const FLIES = 0.4
const ARCS = 1.1
const FALLS = 0.2
/** How far apart jars follow one another when several go at once. */
const APART = 0.12
/** The order the jars go in when the room plays alone: kept or left. */
const SORT = 'klklklkklk'
const ROUND = 30.5

type Power = 'off' | 'starting' | 'fault' | 'online'

interface Told {
  kind: string
  read: boolean
  gate: boolean
  kept: number
  left: number
  power: Power
  stamped: number
}

/** A place in the stack: whether a jar is wanted there, since when, and where it came from. */
interface Stacked {
  on: boolean
  at: number
  by: 'hands' | 'chest'
  /** Its lamp, and when it came on. */
  lit: boolean
  stamped: number
}

export class PacksScene implements RoomScene {
  private readonly rack = new Rack(4, 4, 'off')
  private readonly hand = bodyAt(WORKER, [1, 0])
  private readonly stack: Stacked[] = PLACES.map(() => ({
    on: false,
    at: SETTLED,
    by: 'chest',
    lit: false,
    stamped: SETTLED,
  }))
  private was: Told | null = null
  /** When the jar in his hands came into them, or null with none; and the place it was taken from, if one. */
  private held: number | null = null
  private from = -1
  /** The jar the last start found: its place in the stack. */
  private found = -1
  /** When each thing last happened, on the scene's clock. */
  private gone = SETTLED
  private fell = SETTLED
  private jolted = SETTLED
  private lid = SETTLED
  private swapped = SETTLED
  private pulled = SETTLED
  private faulted = SETTLED
  /** How far over the lever is. */
  private thrown = 0
  /** The small world, on the rack's top plate or riding over it. */
  private readonly world = new Rider()
  /** The round it plays alone starts in the middle of the sort. */
  private own = 9.3

  step(view: View): void {
    const { clock, dt, box } = view
    const told = this.told(view)
    const first = this.was === null
    const was = this.was ?? told
    this.was = told
    const up = told.power === 'starting' || told.power === 'online'
    /** True on the frame the clock passes a moment. */
    const just = (when: number) => clock >= when && clock - dt < when

    // Only changes are acted out; joined part-way, every part is simply as it should be.
    if (first || view.still) {
      this.stack.forEach((place, n) => {
        place.on = n < told.kept
        place.at = SETTLED
        place.lit = n < told.stamped
        place.stamped = SETTLED
      })
      this.held = told.gate ? SETTLED : null
      this.from = -1
      this.found = -1
      this.rack.settle(4, up ? 'on' : 'off')
      this.thrown = up ? 1 : 0
    } else {
      if (told.kind !== was.kind) this.swapped = clock
      if (told.read !== was.read) this.lid = clock
      if (told.kept > was.kept) {
        // The one in his hands goes first, and any others straight out of the chest after it.
        let late = 0
        for (let n = was.kept; n < told.kept; n++) {
          const place = this.stack[n] as Stacked
          const handed = this.held !== null && this.from < 0
          place.on = true
          place.at = clock + late
          place.by = handed ? 'hands' : 'chest'
          if (handed) this.let(clock)
          late += APART
        }
      } else if (told.kept < was.kept) {
        // Back into the chest, the last in first out. With the lever still over it is lifted first.
        let late = was.power === 'starting' || was.power === 'online' ? 0.7 : 0
        for (let n = was.kept - 1; n >= told.kept; n--) {
          const place = this.stack[n] as Stacked
          place.on = false
          place.lit = false
          if (this.held !== null && this.from === n) {
            // The one the start found is in his hands: it is dropped in with the others left out.
            place.at = SETTLED
            this.fell = clock
            this.let(clock)
          } else {
            place.at = clock + late
            late += APART
          }
        }
        this.found = -1
      } else if (told.left > was.left && this.held !== null && this.from < 0) {
        this.fell = clock
        this.let(clock)
      }
      // Each jar's lamp comes on with the check, one after another.
      let late = 0
      this.stack.forEach((place, n) => {
        const lit = n < told.stamped && place.on
        if (lit && !place.lit) {
          place.stamped = clock + late
          late += APART
        }
        place.lit = lit
      })
      if (up && !(was.power === 'starting' || was.power === 'online')) {
        this.pulled = clock
        this.world.whirl += 8
      }
      if (told.power === 'fault' && was.power !== 'fault') {
        this.faulted = clock
        this.found = told.kept - 1
        this.world.bob += 1.6
      }
      if (told.power !== 'fault' && this.held !== null && this.from >= 0) {
        // The start was taken again before the jar was dealt with: it goes back where it was.
        const place = this.stack[this.from] as Stacked
        place.at = clock
        place.by = 'hands'
        this.let(clock)
      }
    }
    const fault = clock - this.faulted
    const swap = clock - this.swapped
    // A jar in his hands with the sort over is dropped back in; with the sort on and his hands
    // empty, the next one pops up. One a start has found is taken out of the stack to be read.
    if (!told.gate && this.held !== null && this.from < 0 && !first && !view.still) {
      this.fell = clock
      this.let(clock)
    }
    if (told.gate && this.held === null && clock - this.gone > 0.1 && swap > 1.2) {
      this.held = clock
      this.from = -1
    }
    const finding = told.power === 'fault' && this.found >= 0 && this.stack[this.found]?.on === true
    if (finding && this.held === null && fault > 1.2) {
      this.held = clock
      this.from = this.found
    }

    // The server: dark until the lever is pulled; at a stop every lamp flashes, and it is dark.
    this.rack.set(
      told.power === 'fault' ? 'fault' : told.power === 'starting' ? 'booting' : up ? 'on' : 'off',
      clock,
    )
    const top = this.rack.draw(box, view.place(RACK[0], RACK[1]), clock)
    const [px, , pz] = view.at(RACK[0], RACK[1] - 0.95)

    // The world it will run, on its plate: still while the server is dark, spun up by a start,
    // and lifted off to ride over the rack once it is online.
    const floating = told.power === 'online'
    box(
      px - 0.45,
      top,
      pz - 0.45,
      0.9,
      0.1,
      0.9,
      up ? 80 : 150,
      up ? Kind.lamp : Kind.iron,
      up ? LIT : 0,
      view.inside,
    )
    const rest = top + (floating ? 0.6 : 0.1)
    if (first || view.still) this.world.settle(rest)
    this.world.step(dt, rest, top + 0.1, floating ? 0.4 : up ? 2.4 : 0)
    smallWorld(
      box,
      { x: px, y: this.world.ride, z: pz, heading: this.world.spin, inside: view.inside },
      'create',
      clock,
    )
    // Warm light on the floor in front of the rack, while its lamps are on.
    view.light(
      RACK[0],
      RACK[1] + 0.9,
      0.6,
      4.5,
      this.rack.power === 'off' || this.rack.power === 'fault' ? 0 : 0.8,
    )

    // The jars. One in the air goes in a single arc; one that lands bounces once.
    const facing = view.facing(0)
    const draw = (at: Point, lit: boolean, scale = 1) => {
      const [x, y, z] = view.at(at[0], at[1], at[2])
      jar(box, { x, y, z, heading: facing, inside: view.inside, scale }, lit)
    }
    this.stack.forEach((place, n) => {
      const spot = PLACES[n] as Point
      const age = clock - place.at
      if (!place.on) {
        // On its way back to the chest, or waiting its turn to go.
        if (age < 0) draw(spot, false)
        else if (age < FLIES) draw(flight(spot, MOUTH, age / FLIES, ARCS), false)
        if (just(place.at + FLIES)) this.jolted = clock
        return
      }
      if (age < 0) return
      if (this.held !== null && this.from === n) {
        // Taken out of the stack to be read: into his hands, and held there.
        draw(flight(spot, HANDS, clamp((clock - this.held) / FLIES), ARCS), false)
        return
      }
      if (age < FLIES) {
        draw(flight(place.by === 'hands' ? HANDS : MOUTH, spot, age / FLIES, ARCS), false)
        return
      }
      if (just(place.at + FLIES)) {
        const [x, y, z] = view.at(spot[0], spot[1], spot[2])
        view.chips([x - 0.5, y, z - 0.5], [0, 0.5, 0], 2, 0.25)
      }
      const bounce = clamp((age - FLIES) / 0.22)
      // The one a start has found jumps in its place, twice, and smokes.
      const jump =
        finding && n === this.found && fault < 0.6 ? Math.abs(Math.sin((fault / 0.3) * Math.PI)) * 0.2 : 0
      const checked = clock - place.stamped
      const pop = place.lit && checked > 0 && checked < 0.25 ? 0.16 * Math.sin((checked / 0.25) * Math.PI) : 0
      draw(
        [spot[0], spot[1], spot[2] + 0.14 * 4 * bounce * (1 - bounce) + jump],
        place.lit && checked > 0,
        1 + pop,
      )
      if (finding && n === this.found) {
        const [x, y, z] = view.at(spot[0], spot[1], spot[2] + 0.5)
        smoke(box, x, y, z, fault, view.inside, 0.5)
      }
    })
    if (this.held !== null && this.from < 0) {
      // Up out of the chest and into his hands, a little past them and back.
      const age = clock - this.held
      const up = overshoot(clamp(age / FALLS))
      draw(
        [lerp(MOUTH[0], HANDS[0], up), HANDS[1], lerp(MOUTH[2], HANDS[2], up)],
        false,
        clamp(age / 0.08, 0.3),
      )
    }
    const falling = (clock - this.fell) / FALLS
    if (falling >= 0 && falling < 1)
      draw([lerp(HANDS[0], MOUTH[0], falling), HANDS[1], lerp(HANDS[2], MOUTH[2], falling ** 2)], false)
    if (just(this.fell + FALLS)) this.jolted = clock

    // The pack's chest. Another kind of file is another chest: the one there hops and is gone,
    // and the next drops in and bounces. Read, its lid is up; whatever lands in it jolts it. Its
    // latch is never lit: a lit latch says a world is inside, and this holds jars.
    const jolt = clock - this.jolted
    const shake = jolt > 0 && jolt < 0.25 ? Math.sin((jolt / 0.25) * Math.PI) : 0
    const lidded = clock - this.lid
    const open = told.read ? overshoot(clamp(lidded / 0.3)) : 1 - clamp(lidded / 0.15)
    if (swap < 0.4) {
      const going = 1 - windup(swap / 0.4)
      chest(box, view.place(CHEST[0], CHEST[1], 0.5 * Math.sin((swap / 0.4) * Math.PI), 0, going), 0, false)
    } else {
      const landing = drop(swap - 0.4, 1.9)
      chest(
        box,
        view.place(CHEST[0], CHEST[1], landing.up + shake * 0.05),
        Math.max(landing.jolt * 0.25, open * (1 - 0.3 * shake)),
        false,
      )
    }

    // The lever on its post: pulled toward the server by a start, sprung back by a stop.
    this.thrown += clamp((up ? 1 : 0) - this.thrown, -dt * (told.power === 'fault' ? 7 : 2.2), dt * 3.4)
    lever(
      box,
      view.place(LEVER[0], LEVER[1], 0, view.handed < 0 ? Math.PI : 0),
      view.still ? (up ? 1 : 0) : this.thrown,
      true,
    )
    wireIn(view, WIRE)
    runIn(view, WIRE, floating ? (clock - this.pulled) % 2.4 : clock - this.pulled - 0.3)

    // The worker turns to the chest to unpack it, and to the lever to start the server.
    const unpacking =
      told.power === 'off'
        ? (told.gate || told.kept + told.left === 0) && this.thrown < 0.1
        : finding
          ? fault > 0.6
          : clock - this.fell < 0.3
    const hand = this.hand
    hand.want = headingOf(unpacking ? [1, 0] : [0, 1])
    const turned = turn(hand, dt)
    const holding = this.held !== null || (told.gate && swap > 1) || (finding && fault > 1)
    const opening = told.read && lidded > 0 && lidded < 0.5
    const arm = reach(
      hand,
      unpacking ? (holding ? -1.25 : opening ? -1.2 : 0) : turned && !floating ? -1.05 : 0,
      dt,
      6,
    )
    // His head: down on the chest for the whole of the sort, with two slow nods into it when it
    // is first read and again over the jar a start has found; up to the stack once when the sort
    // is over, round to the server through a start, and up at the world when it rides.
    const reading =
      this.from >= 0 && this.held !== null ? clock - this.held - FLIES : told.gate ? -1 : lidded - 0.3
    const nod = unpacking
      ? swap < 1
        ? -0.25 + 0.5 * clamp(swap / 0.8)
        : told.read || this.held !== null
          ? 0.3 + (reading > 0 && reading < 1.2 ? 0.18 * Math.abs(Math.sin(reading * 5.2)) : 0)
          : 0.15
      : floating
        ? -0.3
        : 0
    const gaze = unpacking ? 0 : (told.power === 'off' ? 0.5 : 0.9) * view.handed
    worker(
      view,
      hand,
      Math.abs(arm) > 0.02
        ? unpacking && holding
          ? { tool: arm, other: arm, gaze, nod }
          : { tool: arm, gaze, nod }
        : { gaze, nod },
    )
  }

  /** His hands are empty from now. */
  private let(clock: number): void {
    this.held = null
    this.from = -1
    this.gone = clock
  }

  /** What the demonstration says, or, alone, the same values on a clock of its own. */
  private told(view: View): Told {
    const said = view.showing
    if (said) {
      const power = String(said.power)
      return {
        kind: String(said.kind),
        read: said.read === true,
        gate: said.gate === true,
        kept: clamp(Number(said.kept) || 0, 0, PLACES.length),
        left: Number(said.left) || 0,
        power: power === 'starting' || power === 'fault' || power === 'online' ? power : 'off',
        stamped: clamp(Number(said.stamped) || 0, 0, PLACES.length),
      }
    }
    // One held moment: the sort, with a jar in his hands.
    if (view.still) return { kind: '', read: true, gate: true, kept: 3, left: 2, power: 'off', stamped: 0 }
    this.own += view.dt
    const t = this.own % ROUND
    const kind = String(Math.floor(this.own / ROUND))
    if (t >= 27.5) return { kind, read: false, gate: false, kept: 0, left: 0, power: 'off', stamped: 0 }
    const sorted = clamp(Math.floor((t - 5.8) / 0.8) + 1, 0, SORT.length)
    const kept = t >= 18.3 ? 5 : SORT.slice(0, sorted).split('k').length - 1
    const left = t >= 18.3 ? 5 : sorted - kept
    return {
      kind,
      read: t >= 2.5,
      gate: t >= 5 && sorted < SORT.length,
      kept,
      left,
      power:
        t >= 23 ? 'online' : t >= 19.4 ? 'starting' : t >= 15.7 ? 'fault' : t >= 14.5 ? 'starting' : 'off',
      stamped: clamp(Math.floor((t - 21) / 0.3) + 1, 0, 5),
    }
  }
}

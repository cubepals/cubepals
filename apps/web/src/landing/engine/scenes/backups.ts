/**
 * Backups: one server, its keeper at a counter, and chests.
 *
 * The server is the rack on a step at the back, with its own chest on the step beside it. Its
 * small world is shut in that chest while it sleeps, and the chest breathes; while it runs the
 * world rides over the rack and the chest stands open and empty. In front is a counter, a bench
 * to each side of the keeper. A chest on a bench is a backup: shut, its latch lit because a world
 * is in it, and never breathing, because it is a copy and not a server asleep. The left bench is
 * the days, the right one the copies taken before a change or a restore.
 *
 * The room is one verb done both ways. A copy goes into a chest: an empty chest drops onto the
 * bench at his hand, a second world pops up out of the one in the server's chest and drops into
 * his raised hands, he turns, lowers it in, the lid claps shut, the latch lights, and he shoves
 * the chest along the row. A bench holds three, so a fourth pushes the oldest off the far end.
 * And a copy comes back out of one: a change that does not start flashes every lamp and smokes,
 * and the world is still shut in its chest; the newest chest on the right bench throws its lid
 * open, its copy hops into his hands, he lifts it, and it springs into the server's chest, where
 * the one it replaces pops away only as it lands. Deleted, the world itself hops down into his
 * hands and he carries it to the front of the room and stands there holding it: off the server,
 * and not thrown out.
 *
 * It follows the section's demonstration, which says `server` ('asleep', 'on', 'restarting',
 * 'fault', 'trash' or 'gone'), `held` (a running server has been told to stop writing), `own` and
 * `safety` (how many chests are on each bench), `kept` (how long the left bench is) and `back`
 * (which bench the world came back from). Those say where every part ends up; the room gets
 * there by its own moves, one at a time, so it may trail the demonstration by a beat, and a move
 * that has begun is never cut. Joined part-way or held still, every part is simply as it should
 * be. Alone, it gives itself the same values on a clock: a day's backup, and a change that goes
 * back by itself.
 */
import { LIT } from '../chunk'
import { clamp, ease, lerp } from '../curves'
import {
  between,
  flight,
  type Hand,
  handAt,
  headTo,
  type Point,
  ROUND,
  type RoomScene,
  send,
  slab,
  small,
  tread,
  type View,
  worker,
} from '../rooms'
import {
  chest,
  drop,
  overshoot,
  type Place,
  partsAt,
  puff,
  Rack,
  Rider,
  SETTLED,
  type Slot,
  smallWorld,
  swung,
  windup,
} from '../server'
import { type Body, headingOf, type Spot, turn } from '../walk'
import { Kind } from '../world'

/**
 * Where things stand, in the room's terms. The server at the back on its step, which lifts its
 * whole face and its chest clear of the counter; the counter a block in front, low; the keeper
 * in the gap between the two benches.
 */
const STEP_U: readonly number[] = [4.25, 6.25, 7.45]
const STEP_V: Spot = [0.4, 2.3]
const STEP_H = 1.4
const RACK: Spot = [5.25, 2.3]
const CHEST: Spot = [6.9, 2.3]
/** The world's places: over the rack, this far above its top, and in the server's chest. */
const OVER: Spot = [5.25, 1.35]
const RIDES = 0.6
const IN_CHEST: Point = [6.9, 1.85, STEP_H + 0.06]
/** Where a copy has popped up to, clear of that chest's rim, before it sets off. */
const POPPED: Point = [6.9, 1.9, STEP_H + 0.85]
const HOME: Spot = [5.25, 3.5]
const FRONT: Spot = [5.25, 5.3]
/** The counter: how deep and high a bench is, and each bench's place at the keeper's hand. */
const BENCH_V: Spot = [3.05, 3.95]
const BENCH_H = 0.5
const ENTRY: Spot = [4.275, 6.225]
const PITCH = 0.95
const ROW = (BENCH_V[0] + BENCH_V[1]) / 2
/** A bench is three places and the entry place; the left one has a fourth on the longer plan. */
const PLACES = 3
/** What a head turns to: the smoke beside the rack's top, and down into the server's chest. */
const SMOKE: Point = [5.9, 1.65, 4.3]
const BED: Point = [6.9, 1.85, 2.3]

/** A world sprung out of a chest, or up into one from his hands, is this long in the air. */
const SPRINGS = 0.45
/** Told to stop, the world slows on its spring, hops off the rack and falls; by `LANDS` it is in. */
const SLOWS = 0.25
const FALLS = 0.5
const LANDS = SLOWS + FALLS
/** How much of its fall it first hops up by. */
const HOPS = 0.87
/** How long three trays take to light from the bottom, to go out from the top, and to stay dark. */
const BOOTS = 0.9
const DARKENS = 0.62
const DARK = DARKENS + 0.4
/**
 * A copy taken, in seconds from the count going up: it has popped out of the server's chest, is
 * in his hands, he has turned to the bench, he lets go at the rim, and it is in and shut.
 */
const POPS = 0.2
const CAUGHT = 0.65
const TURNED = 0.95
const LETGO = 1.15
const SHELVED = 1.35
/** A copy fetched from a bench: it pops up, and is this long in the air from the far end or the near. */
const RISES = 0.15
const LONG = 0.55
const SHORT = 0.4
/** How long a chest shoved off the end of a bench is pushed before it starts to tip. */
const TIPS = 0.085
/** His arms: up to catch, carrying, out to a bench, holding at his chest, and overhead. */
const CATCH = -2.05
const CARRY = -1.8
const LOWER = -1.5
const OUT = -1.57
const HOLD = -1.0
const LIFT = -2.5
/** The round it plays alone, and where in it the room is first found. */
const ALONE = 22
const ENTERS = 3.5

type Server = 'asleep' | 'on' | 'restarting' | 'fault' | 'trash' | 'gone'
const SERVERS: readonly string[] = ['asleep', 'on', 'restarting', 'fault', 'trash', 'gone']
type Back = 'none' | 'own' | 'safety'

interface Told {
  server: Server
  held: boolean
  own: number
  safety: number
  kept: number
  back: Back
}

/** What the demonstration says when the page opens. */
const OPENING: Told = { server: 'asleep', held: false, own: 3, safety: 0, kept: 3, back: 'none' }

/** A backup: one chest on a bench. */
interface Crate {
  /** The place it stands on, 0 the entry place; the one it was shoved from, and when. */
  place: number
  from: number
  shoved: number
  /** When it was dropped onto the bench. */
  landed: number
  lid: Slot
  /** A copy is in it; and when one last landed in it. */
  full: boolean
  thumped: number
  /** How it leaves, once it is not wanted, and since when. */
  leaving: 'pop' | 'fall' | 'hatch' | null
  left: number
}

/** A bench: its chests from the keeper's end outward, those on their way off it, and the count acted on. */
interface Bench {
  crates: Crate[]
  gone: Crate[]
  count: number
}

/** What the keeper is doing: one thing at a time, and it is finished before the next. */
interface Job {
  kind: 'copy' | 'shove' | 'fetch' | 'bin' | 'unbin' | 'home'
  /** The bench it is at, 0 the left. */
  side: number
  /** When it was called for; when it began, once he and the server were ready; its second part. */
  asked: number
  at: number | null
  next: number | null
  crate: Crate | null
}

type Face = 'step' | 'left' | 'right' | 'out'
const WAYS: Record<Face, Spot> = { step: [0, -1], left: [-1, 0], right: [1, 0], out: [0, 1] }

/** Which way a bench runs from the keeper, and where along the room one of its places is. */
const wayOf = (side: number) => (side === 0 ? -1 : 1)
const along = (side: number, place: number) => (ENTRY[side] as number) + wayOf(side) * PITCH * place

const crateAt = (place: number, landed: number, full: boolean): Crate => ({
  place,
  from: place,
  shoved: SETTLED,
  landed,
  lid: { on: false, at: SETTLED },
  full,
  thumped: SETTLED,
  leaving: null,
  left: SETTLED,
})

export class BackupsScene implements RoomScene {
  private readonly rack = new Rack(3, 3, 'off')
  private readonly rider = new Rider()
  private readonly hand: Hand = handAt(HOME, [0, 1])
  private readonly benches: readonly [Bench, Bench] = [
    { crates: [], gone: [], count: 0 },
    { crates: [], gone: [], count: 0 },
  ]
  private was: Told | null = null
  /** A machine is wanted on the step; its chest, and that chest's lid. */
  private built = true
  private disk: Slot = { on: true, at: SETTLED }
  private flap: Slot = { on: false, at: SETTLED }
  /** The lamps, and when they were last switched. */
  private lit = false
  private switched = SETTLED
  /** A restart is owed: the lamps have still to go out for it. And a change has failed to start. */
  private reboot = false
  private tripped = false
  /** The world: where it is, how it got there and when it set off, and how it lies in its chest. */
  private world: 'over' | 'chest' | 'hands' | 'air' | 'none' = 'chest'
  private how: 'sprung' | 'dropped' | 'thrown' | 'hopped' | 'popped' | 'spent' = 'popped'
  private moved = SETTLED
  private turned = 0
  /** Where it is drawn, if it is: it pops away from there. And when it popped away in his hands. */
  private last: Place | null = null
  private emptied = SETTLED
  /** A world on its way up into the server's chest from his hands. */
  private incoming: { from: Point; at: number } | null = null
  /** When the world a restore replaced was landed on. */
  private ousted = SETTLED
  /** The restore the room has acted out. */
  private back: Back = 'none'
  /** The longer plan's fourth place on the left bench, and the hatch it runs on into. */
  private shelf: Slot = { on: false, at: SETTLED }
  private job: Job | null = null
  /** Until when the server is doing something worth watching. */
  private stirred = SETTLED
  /** The chest's breath: whether it is breathing, when it began, and when it stopped. */
  private breathes = false
  private breathFrom = SETTLED
  private breathTo = SETTLED
  /** The keeper's arms and head, each moved to where it is wanted and never put there. */
  private tool = 0
  private other = 0
  private gaze = 0
  private nod = 0
  /** The one picture held for less motion: the copy just put in its chest. */
  private posed = false
  /** Somebody has pressed something in the demonstration. */
  private pressed = false
  /** The round it plays alone: seconds into it, the right bench's count, and whether it is playing it. */
  private round = ENTERS
  private spare = 0
  private alone = true

  step(view: View): void {
    const { clock, dt, box } = view
    const told = this.told(view)
    const first = this.was === null
    const was = this.was ?? told
    this.was = told
    const want = told.server
    /** True on the frame the clock passes a moment. */
    const just = (when: number) => clock >= when && clock - dt < when
    // Where the world belongs, once everything has finished moving.
    const where =
      want === 'gone' ? 'none' : want === 'trash' ? 'hands' : want === 'on' && !told.held ? 'over' : 'chest'
    const square = view.facing(0)
    const hand = this.hand

    // Only changes are acted out; joined part-way or held still, every part is as it should be.
    if (first || view.still) this.settle(told, view, first)
    else if (want !== was.server && was.server === 'on' && (want === 'restarting' || want === 'fault'))
      this.reboot = this.lit

    // The machine. Past its days in the trash it is let go, once its world and every backup have
    // gone: its chest pops away, and then its trays are pulled. Wanted again, the trays are
    // pushed home first and the chest drops in beside them.
    const bare = this.benches.every((bench) => bench.crates.length + bench.gone.length === 0)
    if (want !== 'gone') this.built = true
    else if (
      this.world === 'none' &&
      !this.lit &&
      bare &&
      clock - this.moved > 0.4 &&
      this.job?.kind !== 'bin'
    )
      this.built = false
    const home = this.rack.slots.every((slot) => slot.on && clock - slot.at > 0.7)
    if (this.built !== this.disk.on && (home || !this.built)) {
      this.disk = { on: this.built, at: clock }
      // A new chest's lid is thrown open by its landing.
      this.flap = { on: this.built, at: clock + (this.built ? 0.36 : 0) }
      this.stir(clock + 0.8)
    }
    this.rack.size(this.built || this.disk.on || clock - this.disk.at < 0.4 ? 3 : 0, clock)
    const building = this.rack.slots.some((slot) => clock - slot.at < 0.9)
    if (building) this.stir(clock)

    if (!view.still) {
      // A world sprung from his hands has landed in the server's chest. Whatever was in it is
      // there until this moment and no longer: nothing is lost before its replacement arrives.
      if (this.incoming && clock - this.incoming.at >= SPRINGS) {
        if (this.world === 'chest') this.ousted = clock
        this.world = 'chest'
        this.how = 'thrown'
        this.moved = this.incoming.at
        this.turned = square
        this.incoming = null
        this.stir(clock + 0.4)
      }
      // A chest put back on the step with nobody to carry a world to it: one pops up in it.
      if (this.world === 'none' && where !== 'none' && this.disk.on && clock - this.disk.at > 0.8) {
        this.world = 'chest'
        this.how = 'popped'
        this.moved = clock
        this.turned = square
      }
      // Gone for good: it pops away wherever it is, in his hands if that is where.
      if (want === 'gone' && this.world !== 'none' && this.world !== 'air') {
        if (this.world === 'hands') this.emptied = clock
        this.world = 'none'
        this.how = 'spent'
        this.moved = clock
      }
      // Told to stop, or to stop writing: it hops off the rack and drops into its open chest.
      if (this.world === 'over' && where !== 'over' && clock - this.moved > SPRINGS + 0.1) {
        this.world = 'chest'
        this.how = 'dropped'
        this.moved = clock
        // It comes to lie square in its chest.
        this.turned = square + Math.round((this.rider.spin - square) / (Math.PI / 2)) * (Math.PI / 2)
        this.stir(clock + LANDS + 0.3)
      }
    }
    const job = this.job
    // How long ago the lamps were switched, as this frame began.
    const since = clock - this.switched
    const lies = this.lies(clock)
    /** How long the job has been going, once it has begun. */
    const t = job && job.at !== null ? clock - job.at : -1
    // A restore still to be acted out, or on its way: the lamps and the world wait for it.
    const fetching = told.back !== this.back || job?.kind === 'fetch' || this.incoming !== null

    if (!view.still) {
      // The server's chest's lid. It is up while the chest is empty, while a server told to stop
      // writing shows its world, and for as long as something is coming out of it or going in.
      // Otherwise whatever has landed in it has knocked it shut.
      const using =
        t >= 0 &&
        ((job?.kind === 'copy' && t < 0.5) ||
          (job?.kind === 'fetch' && job.next !== null && clock >= job.next + 0.45) ||
          job?.kind === 'bin')
      const ajar =
        this.world !== 'chest' ||
        (want === 'on' && told.held && this.lit && since > BOOTS) ||
        using ||
        this.incoming !== null
      if (this.disk.on && ajar !== this.flap.on && clock >= this.flap.at && (ajar || lies)) {
        this.flap = { on: ajar, at: clock }
        this.stir(clock + 0.3)
      }
      const shut = lies && !this.flap.on

      // The lamps. Save, then stop: they go out only once the world is shut in its chest. A
      // restart puts them out, waits in the dark (for the world from a bench, if one is coming),
      // and boots; a change that does not start flashes them all once they have come on.
      if (this.reboot) {
        if (!this.lit) this.reboot = false
        else if (shut) {
          this.power('off', clock)
          this.reboot = false
        }
      } else if (want === 'on' || want === 'restarting' || (want === 'fault' && !this.tripped)) {
        const ready = this.world === 'over' || lies
        if (!this.lit) {
          if (home && this.disk.on && ready && !fetching && since > DARK) this.power('booting', clock)
        } else if (want === 'on' && since > BOOTS) this.rack.set('on', clock)
        else if (want === 'fault' && since > BOOTS - 0.2) {
          this.rack.set('fault', clock)
          this.lit = false
          this.switched = clock
          this.tripped = true
          this.stir(clock + 1)
        }
      } else if (this.lit && (shut || this.world === 'none' || this.world === 'hands'))
        this.power('off', clock)
      if (want !== 'fault') this.tripped = false

      // With its last lamp on, the lid is thrown open and the world springs out to ride.
      const copying = job?.kind === 'copy' && t >= 0 && t < 0.3
      if (lies && where === 'over' && this.lit && clock - this.switched > BOOTS && !fetching && !copying) {
        this.world = 'over'
        this.how = 'sprung'
        this.moved = clock
        this.flap = { on: true, at: clock }
        this.rider.spin = this.turned
        this.rider.whirl = 8
        this.stir(clock + SPRINGS + 0.4)
      }

      // The longer plan: one more slab of bench at the far end, and the hatch the shelf runs on
      // through. Back on the shorter one it goes once nothing stands on it.
      const longer = told.kept > PLACES
      const stood = this.benches[0].crates.some((crate) => crate.place > PLACES)
      if (longer !== this.shelf.on && clock - this.shelf.at > 0.6 && (longer || !stood))
        this.shelf = { on: longer, at: clock }

      this.tend(told, where, clock)
    }

    // The step, and the server on it.
    for (let n = 0; n + 1 < STEP_U.length; n++)
      slab(
        view,
        STEP_U[n] as number,
        STEP_V[0],
        STEP_U[n + 1] as number,
        STEP_V[1],
        0,
        STEP_H,
        150,
        Kind.cobble,
      )
    const top = this.rack.draw(box, view.place(RACK[0], RACK[1], STEP_H), clock)
    const rest = top - view.at(0, 0)[1] + RIDES
    // Warm light on the floor in front of lamps that are lit: it grows a tray at a time as they
    // boot, goes with the last of them, and flashes with them at a fault. (`dark` is how long ago
    // they were switched, now that this frame has had its chance to switch them.)
    const dark = clock - this.switched
    const glowing = this.lit
      ? Math.min(3, Math.floor(dark / 0.3) + 1)
      : this.rack.power === 'fault'
        ? dark < 0.6 && Math.floor(dark / 0.1) % 2 === 0
          ? 3
          : 0
        : dark < 0.18
          ? 3
          : dark < 0.4
            ? 2
            : dark < DARKENS
              ? 1
              : 0
    view.light(HOME[0], 3.3, 1.6, 5, (0.8 * glowing) / 3)

    // What he is doing, a step at a time, and from it where he faces, where his arms are wanted
    // and what he looks at. A world in his hands is drawn once his arms are where they are.
    let face: Face = 'out'
    let both = 0
    let near = 0
    let look: Point | null = null
    /** His head simply down on what his hands are doing, by this much. */
    let bent: number | null = null
    let walking = false
    /** A copy out of a chest and not yet in another: where it is, and how big. */
    let copy: Point | null = null
    let copied = 0.85
    const hands = carried(hand, this.tool)
    const toward = (to: Face) => Math.abs(Math.sin((hand.heading - headingOf(WAYS[to])) / 2)) < 0.03
    const sideways: Face = job?.side === 1 ? 'right' : 'left'

    if (job?.kind === 'copy') {
      // A backup is taken. An empty chest drops onto the entry place and its landing throws the
      // lid open; a second world pops up out of the one in the server's chest and drops in one
      // arc into his raised hands; he turns with it, lowers it, lets go at the rim; it settles,
      // the chest bounces, the lid claps shut and the latch lights.
      face = t < CAUGHT ? 'step' : sideways
      const bench = this.benches[job.side] as Bench
      if (job.at === null) {
        // Under a world held still with its lid up his arms are up already; at a shut chest they
        // go up as its lid is thrown.
        both = lies && this.flap.on ? CATCH : 0
        look = BED
        if (where !== 'chest' || !this.disk.on || clock - job.asked > 2.5) {
          // The server is no longer holding its world still to be copied: the chest simply arrives.
          bench.crates.unshift(crateAt(0, clock, true))
          this.job = null
        } else if (toward('step') && lies && dark > (this.lit ? BOOTS : DARKENS)) {
          job.at = clock
          job.crate = crateAt(0, clock, false)
          job.crate.lid = { on: true, at: clock + 0.36 }
          bench.crates.unshift(job.crate)
          this.stir(clock + 0.6)
        }
      } else {
        const crate = job.crate as Crate
        const inside: Point = [along(job.side, 0), ROW, BENCH_H + 0.06]
        if (t < POPS) {
          const up = overshoot(t / POPS)
          copy = [IN_CHEST[0], lerp(IN_CHEST[1], POPPED[1], up), lerp(IN_CHEST[2], POPPED[2], up)]
          copied = 0.85 * up
          look = BED
        } else if (t < CAUGHT) {
          copy = round(POPPED, hands, (t - POPS) / (CAUGHT - POPS), 0.4, false)
          look = copy
        } else if (t < LETGO) copy = hands
        else if (t < SHELVED) {
          const fall = (t - LETGO) / (SHELVED - LETGO)
          copy = [
            lerp(hands[0], inside[0], fall),
            lerp(hands[1], inside[1], fall),
            lerp(hands[2], inside[2], fall ** 2),
          ]
        }
        if (just(job.at + SHELVED)) {
          crate.full = true
          crate.thumped = clock
          crate.lid = { on: false, at: clock + 0.1 }
        }
        both = t < CAUGHT - 0.05 ? CATCH : t < TURNED ? CARRY : t < SHELVED ? LOWER : 0
        if (t >= CAUGHT) bent = 0.35
        if (t >= SHELVED + 0.15) this.job = null
      }
    } else if (job?.kind === 'shove') {
      // One hand out, and the row goes one place along: a touch too far, and back.
      face = sideways
      bent = 0.2
      if (job.at === null) {
        if (toward(face)) job.at = clock
      } else {
        if (just(job.at + 0.14)) this.push(job.side, clock)
        if (t >= 0.6) this.job = null
      }
      near = t < 0.42 ? -1.35 : 0
    } else if (job?.kind === 'fetch') {
      // A world comes back from a bench. That chest throws its lid open, a second world pops up
      // out of the one in it and hops into his hands, and the lid claps shut on the one that
      // stays. He turns to the step and lifts it; the server's chest is thrown open; it springs
      // up into it.
      const crate = job.crate as Crate
      const flies = job.side === 0 ? LONG : SHORT
      const held = RISES + flies
      const inside: Point = [along(job.side, crate.place), ROW, BENCH_H + 0.06]
      const risen: Point = [inside[0], ROW, BENCH_H + 0.75]
      face = job.next === null ? sideways : 'step'
      if (job.at === null) {
        both = toward(face) ? OUT : 0
        look = [inside[0], ROW, BENCH_H + 0.9]
        if (clock - job.asked > 3 || crate.leaving !== null) {
          this.back = told.back
          this.job = null
        } else if (toward(face) && lies && !this.flap.on && !this.lit && dark > 0.25) {
          job.at = clock
          this.back = told.back
          crate.lid = { on: true, at: clock }
        }
      } else if (job.next === null) {
        if (t < RISES) {
          const up = overshoot(t / RISES)
          copy = [inside[0], ROW, lerp(inside[2], risen[2], up)]
          copied = 0.85 * up
        } else if (t < held) copy = flight(risen, hands, (t - RISES) / flies, job.side === 0 ? 0.55 : 0.4)
        else copy = hands
        look = copy
        both = t < held - 0.1 ? OUT : CARRY
        if (just(job.at + held - 0.08)) crate.lid = { on: false, at: clock }
        if (t >= held) job.next = clock
      } else {
        const lifted = clock - job.next
        if (!this.incoming && lifted < 0.6) copy = hands
        both = lifted < 0.3 ? CATCH : lifted < 0.75 ? LIFT : 0
        look = BED
        if (just(job.next + 0.6)) this.incoming = { from: hands, at: clock }
        if (lifted > 0.6 && !this.incoming) this.job = null
      }
    } else if (job?.kind === 'bin') {
      // Deleted. The world drops into its chest if it is up and the lamps go out; then the lid is
      // thrown open and the world itself hops out and down into his hands. He turns to the open
      // wall, walks out through the gap in the counter, and stops.
      if (job.at === null) {
        face = 'step'
        look = BED
        if (want !== 'trash' || this.world === 'none') this.job = null
        else if (toward('step') && lies && !this.lit && dark > DARKENS) job.at = clock
      } else if (t < 0.95) {
        face = 'step'
        both = t < 0.6 ? CATCH : HOLD
        look = t < 0.65 ? BED : null
        if (just(job.at + 0.2)) {
          this.world = 'hands'
          this.how = 'hopped'
          this.moved = clock
        }
      } else {
        if (job.next === null) {
          job.next = clock
          send(hand, FRONT)
        }
        both = HOLD
        walking = true
        if (this.world !== 'hands' || tread(hand, ROUND, dt)) this.job = null
      }
    } else if (job?.kind === 'unbin') {
      // Brought back: he turns round, walks back to his place, lifts it, and it springs up into
      // the server's chest, which has stood open and empty all the while.
      if (job.at === null) {
        job.at = clock
        send(hand, HOME)
      }
      both = HOLD
      if (!tread(hand, ROUND, dt)) walking = true
      else if (this.world !== 'hands' && job.next === null) this.job = null
      else {
        if (job.next === null) job.next = clock
        const lifted = clock - job.next
        face = 'step'
        both = lifted < 0.55 ? LIFT : 0
        look = BED
        if (just(job.next + 0.4)) {
          this.incoming = { from: hands, at: clock }
          this.world = 'air'
        }
        if (lifted > 0.4 && !this.incoming) this.job = null
      }
    } else if (job?.kind === 'home') {
      // His hands empty at the front of the room, he walks back to his place.
      if (job.at === null) {
        job.at = clock
        send(hand, HOME)
      }
      walking = true
      if (tread(hand, ROUND, dt)) this.job = null
    } else if (this.world === 'hands') {
      // In the trash he stands, the world in both hands at his chest, and every five seconds
      // looks down at it for a second and a half.
      both = HOLD
      const waited = (clock - this.moved) % 5
      bent = view.still ? 0 : waited >= 3.5 ? 0.5 : 0
    } else if (clock - this.emptied < 0.9) {
      // It has popped away in his hands: he looks down at them, and lets them fall.
      both = clock - this.emptied < 0.6 ? HOLD : 0
      bent = 0.5
    } else if (this.posed) {
      // The held picture: the copy just put in its chest, both his hands at its rim.
      face = 'left'
      both = LOWER
      bent = 0.35
    } else if (hand.z === HOME[1]) {
      // Nothing in his hands. He turns to the step for as long as the server is doing something,
      // and for a couple of seconds after a running one last did; arms up under a world that is
      // being held still to be copied. After a change that did not start, his head goes up to the
      // smoke, and then he turns to the right bench and holds both arms out for what comes back.
      const awaiting = want === 'on' && told.held && this.world === 'chest'
      const failed =
        want === 'fault' && this.tripped && told.back === 'none' && this.benches[1].crates.length > 0
      const watching =
        want === 'restarting' || want === 'fault' || clock < this.stirred + (want === 'on' ? 2 : 0.3)
      if (failed && dark > 0.45) {
        face = 'right'
        both = toward('right') ? OUT : 0
        bent = 0.2
      } else if (awaiting || watching) {
        face = 'step'
        both = awaiting && lies && this.flap.on && clock - this.flap.at > 0.25 ? CATCH : 0
        const air = clock - this.moved
        // His head: to the smoke; to trays on their way in or out; down the rack with the lamps
        // as they go out and up it as they come on; into the chest after a world that drops; and
        // up at one that rides.
        if (this.rack.power === 'fault' && dark < 1.4) look = SMOKE
        else if (building) look = [RACK[0], RACK[1], STEP_H + 1.2]
        else if (this.world === 'chest' && this.how === 'dropped' && air < LANDS + 0.5) look = BED
        else if (dark < BOOTS + 0.2 || this.rack.power === 'booting') {
          const tray = this.lit
            ? Math.min(2, Math.floor(dark / 0.3))
            : 2 - Math.min(2, Math.floor(dark / 0.22))
          look = [RACK[0], RACK[1], STEP_H + (tray + 0.7) * 0.8]
        } else look = this.world === 'over' ? [OVER[0], OVER[1], rest + 0.5] : BED
      }
    }

    // He turns on his spot; walking, his legs turn him.
    if (!walking) {
      hand.want = headingOf(WAYS[face])
      if (first || view.still) hand.heading = hand.want
      turn(hand, dt)
    }
    // His head goes first, to whatever just happened; over a chest or a world in his hands it is
    // simply down on it. Back from a restore, he nods once, slowly, up at the world as it rides.
    let [gaze, nod] = bent !== null ? [0, bent] : look ? headTo(hand, look, view.handed, 0.6) : [0, 0]
    const rode = clock - this.moved - SPRINGS - 0.15
    if (this.back !== 'none' && this.how === 'sprung' && rode > 0 && rode < 0.7 && face === 'step')
      nod += 0.3 * Math.sin((rode / 0.7) * Math.PI)
    this.gaze += clamp(gaze - this.gaze, -dt * 5, dt * 5)
    this.nod += clamp(nod - this.nod, -dt * 3.5, dt * 3.5)
    // His arms: both for a world, and for a shove the one on the camera's side.
    const nearest = (face === 'left') === view.handed > 0
    const tool = both || (nearest ? near : 0)
    const other = both || (nearest ? 0 : near)
    this.tool += clamp(tool - this.tool, -dt * 9, dt * 9)
    this.other += clamp(other - this.other, -dt * 9, dt * 9)
    if (first || view.still) {
      this.gaze = gaze
      this.nod = nod
      this.tool = tool
      this.other = other
    }

    // The world. It rides on its spring over the rack; it goes between there and its chest in
    // one arc that clears the rack's corner; lying in a chest with the lid up it shows over the
    // rim; in his hands it goes where they go.
    if (this.world === 'over' && this.how === 'sprung' && just(this.moved + SPRINGS)) {
      this.rider.settle(rest)
      this.rider.bob = 1.2
    }
    if (first || view.still) this.rider.settle(rest)
    this.rider.step(dt, rest, rest - 0.5, this.world === 'over' && where === 'over' ? 0.4 : 0)
    const air = clock - this.moved
    if (this.world !== 'none') this.last = null
    const up = Math.max(swung(this.flap, clock), drop(clock - this.disk.at, 1.9).jolt * 0.25)
    const dropped = this.world === 'chest' && this.how === 'dropped'
    const flown = dropped ? LANDS : this.how === 'thrown' ? SPRINGS : 0
    if (this.world === 'over' && this.how === 'sprung' && air < SPRINGS) {
      const through = air / SPRINGS
      this.show(
        view,
        between(IN_CHEST, [OVER[0], OVER[1], rest], ease(through), overshoot(through)),
        this.rider.spin,
        lerp(0.85, 1, through),
      )
    } else if (this.world === 'over' || (dropped && air < SLOWS)) {
      this.show(view, [OVER[0], OVER[1], this.rider.ride], this.rider.spin, 1)
    } else if (dropped && air < LANDS) {
      const through = (air - SLOWS) / FALLS
      this.show(
        view,
        between(
          [OVER[0], OVER[1], rest],
          IN_CHEST,
          1 - (1 - through) ** 2,
          (1 + HOPS) * through * through - HOPS * through,
        ),
        lerp(this.rider.spin, this.turned, through),
        lerp(1, 0.85, through),
      )
    } else if (this.world === 'chest' && this.disk.on && up > 0.35) {
      // What has landed in it bounces; one that nobody brought pops up.
      const popped = this.how === 'popped'
      const bounce = popped ? 0 : drop(0.36 + air - flown, dropped ? 1.5 : 0.8).up
      const size = popped ? overshoot(clamp(air / 0.3)) : 1
      this.show(view, [IN_CHEST[0], IN_CHEST[1], IN_CHEST[2] + bounce], this.turned, 0.85 * size)
    } else if (this.world === 'hands') {
      const hopping = this.how === 'hopped' && air < SPRINGS
      this.show(
        view,
        hopping ? round(POPPED, hands, air / SPRINGS, 0.4, false) : hands,
        view.facing(hand.heading),
        0.85,
      )
    } else if (this.world === 'none' && this.how === 'spent' && air < 0.25 && this.last) {
      smallWorld(
        box,
        { ...this.last, scale: (this.last.scale ?? 1) * (1 - windup(air / 0.25)) },
        'survival',
        clock,
      )
    }
    // One sprung up from his hands goes across the room first, round the rack's corner.
    if (this.incoming)
      small(
        view,
        round(this.incoming.from, IN_CHEST, clamp((clock - this.incoming.at) / SPRINGS), 0.8, true),
        square,
        0.85,
      )
    // The one a restore replaced pops away as the other lands on it.
    const gone = clock - this.ousted
    if (gone < 0.2) small(view, IN_CHEST, square, 0.85 * (1 - windup(gone / 0.2)))
    if (copy) small(view, copy, view.facing(hand.heading), copied)

    // The server's chest on the step. Dropped in, it bounces and its lid jumps; what lands in it
    // jolts the lid; let go, it hops and pops away. Its latch is lit while the world is in it.
    const stood = clock - this.disk.at
    if (this.disk.on) {
      const thump = this.world === 'chest' && flown > 0 ? drop(0.36 + air - flown, 1).jolt : 0
      chest(
        box,
        view.place(CHEST[0], CHEST[1], STEP_H + drop(stood, 1.9).up),
        up * (1 - 0.25 * thump),
        this.world === 'chest' && air >= flown,
      )
    } else if (stood < 0.4) {
      chest(
        box,
        view.place(
          CHEST[0],
          CHEST[1],
          STEP_H + 0.5 * Math.sin((stood / 0.4) * Math.PI),
          0,
          1 - windup(stood / 0.4),
        ),
        swung(this.flap, clock),
        false,
      )
    }
    // Asleep, it breathes: from a little after the last lamp is out and the world has come to
    // lie in it, until the first lamp is lit. A copy taken out of it only stops its breath for as
    // long as the lid is up.
    const asleep =
      want === 'asleep' &&
      lies &&
      !this.flap.on &&
      clock - this.flap.at > 0.15 &&
      !this.lit &&
      clock - Math.max(this.switched + DARKENS, this.moved + flown) > 1.2
    if (asleep !== this.breathes) {
      this.breathes = asleep
      if (asleep) this.breathFrom = clock
      else this.breathTo = clock
    }
    breathing(
      box,
      view.place(CHEST[0], CHEST[1], STEP_H),
      clock - this.breathFrom,
      this.breathes ? -1 : clock - this.breathTo,
    )

    // The counter: two benches of planks, and on the longer plan a slab more and the hatch.
    for (const side of [0, 1]) {
      const way = wayOf(side)
      const from = (ENTRY[side] as number) - way * 0.475
      for (const part of [0, 1])
        slab(
          view,
          from + way * part * 1.9,
          BENCH_V[0],
          from + way * (part + 1) * 1.9,
          BENCH_V[1],
          0,
          BENCH_H,
          250,
          Kind.planks,
        )
    }
    const laid = clock - this.shelf.at
    if (this.shelf.on) {
      slab(view, 0, BENCH_V[0], 0.95, BENCH_V[1], drop(laid, 2).up, BENCH_H, 250, Kind.planks)
      slab(view, 0, 3, 0.06, 4, BENCH_H, 1.4 * overshoot(clamp((laid - 0.36) / 0.3)), 30, Kind.dark)
    } else if (laid < 0.4) {
      const size = 1 - windup(laid / 0.4)
      const hop = 0.4 * Math.sin((laid / 0.4) * Math.PI)
      slab(
        view,
        0.475 * (1 - size),
        ROW - 0.45 * size,
        0.475 * (1 + size),
        ROW + 0.45 * size,
        hop,
        BENCH_H * size,
        250,
        Kind.planks,
      )
      slab(view, 0, 3, 0.06, 4, BENCH_H, 1.4 * (1 - clamp(laid / 0.15) ** 2), 30, Kind.dark)
    }

    // The backups. A chest on a bench is shut with its latch lit; it is open only while a copy
    // is on its way in or out. One shoved along goes a touch too far and comes back, and its lid
    // jumps as the row stops.
    this.benches.forEach((each, side) => {
      for (const crate of each.crates) this.crate(view, side, crate, want !== 'gone')
      for (const crate of each.gone) this.crate(view, side, crate, want !== 'gone')
      each.gone = each.gone.filter((crate) => clock - crate.left < (crate.leaving === 'fall' ? 1 : 0.4))
    })

    worker(
      view,
      hand,
      Math.abs(this.tool) + Math.abs(this.other) > 0.02
        ? { tool: this.tool, other: this.other, gaze: this.gaze, nod: this.nod }
        : { gaze: this.gaze, nod: this.nod },
    )
  }

  /** The world is in the server's chest and has come to rest there. */
  private lies(clock: number): boolean {
    const flown = this.how === 'dropped' ? LANDS : this.how === 'thrown' ? SPRINGS : 0
    return this.world === 'chest' && clock - this.moved > flown + 0.12
  }

  /** The server is doing something worth watching until then. */
  private stir(until: number): void {
    this.stirred = Math.max(this.stirred, until)
  }

  /** Switches the lamps: on from the bottom tray, or out from the top. */
  private power(power: 'booting' | 'off', clock: number): void {
    this.rack.set(power, clock)
    this.lit = power !== 'off'
    this.switched = clock
    this.stir(clock + (this.lit ? BOOTS : DARKENS))
  }

  /** The server's own world at a place in the room, which is remembered: it pops away from there. */
  private show(view: View, at: Point, heading: number, scale: number): void {
    const [x, y, z] = view.at(at[0], at[1], at[2])
    this.last = { x, y, z, heading, inside: view.inside, scale }
    smallWorld(view.box, this.last, 'survival', view.clock)
  }

  /**
   * Gives the keeper the next thing to do, when his hands are free: the trash and the way back
   * from it, then whatever a bench wants of him, and then a world to bring back from one.
   */
  private tend(told: Told, where: string, clock: number): void {
    const wants = this.shelve(told, where, clock)
    // With no world in the server's chest to replace, a restore said is one there is nothing to
    // act out.
    if (told.back !== this.back && this.job?.kind !== 'fetch' && (told.back === 'none' || where !== 'chest'))
      this.back = told.back
    if (this.job) return
    const job = (kind: Job['kind'], side = 0, crate: Crate | null = null): Job => ({
      kind,
      side,
      asked: clock,
      at: null,
      next: null,
      crate,
    })
    if (this.world === 'hands') {
      if (where !== 'hands' && where !== 'none') this.job = job('unbin')
      return
    }
    if (this.hand.x !== HOME[0] || this.hand.z !== HOME[1]) {
      if (clock - this.moved > 1.2) this.job = job('home')
      return
    }
    if (where === 'hands' && this.world !== 'none' && this.world !== 'air') {
      this.job = job('bin')
      return
    }
    if (wants) {
      if (wants.kind === 'copy') wants.bench.count += 1
      this.job = job(wants.kind, wants.side)
      return
    }
    if (told.back !== this.back) {
      // The newest of those taken before a change, or the oldest of the days.
      const side = told.back === 'own' ? 0 : 1
      const crates = this.benches[side].crates
      const source = side === 0 ? crates[crates.length - 1] : crates[0]
      if (!source) this.back = told.back
      else if (this.world === 'chest') this.job = job('fetch', side, source)
    }
  }

  /**
   * Brings the benches toward the counts said. What a bench does by itself happens whatever the
   * keeper is at: chests dropping straight in, and chests popping away. What needs his hands is
   * handed back: a backup to take, or a row to shove. The left bench comes first.
   */
  private shelve(
    told: Told,
    where: string,
    clock: number,
  ): { kind: 'copy' | 'shove'; side: number; bench: Bench } | null {
    let wants: { kind: 'copy' | 'shove'; side: number; bench: Bench } | null = null
    for (const side of [0, 1]) {
      // A bench he is at is left alone until he has finished there.
      if (this.job && this.job.kind !== 'home' && this.job.side === side) continue
      const bench = this.benches[side] as Bench
      const count = side === 0 ? told.own : told.safety
      const hatch = side === 0 && this.shelf.on
      const places = hatch ? PLACES + 1 : PLACES
      const crates = bench.crates
      const taken = crates[0]?.place === 0
      // With no hatch a bench can show one more than its places: the newest, still at his hand.
      const wanted = Math.min(count, hatch ? places : places + 1)
      if (count - bench.count === 1 && where === 'chest' && this.disk.on) {
        // One more is a backup taken. With the entry place still full he shoves the row first.
        wants ??= { kind: taken ? 'shove' : 'copy', side, bench }
        continue
      }
      bench.count = count
      if (crates.length < wanted) {
        // Several more at once is the room being handed a state: each drops straight onto its
        // resting place, far end first, with nothing carried.
        const free: number[] = []
        for (
          let place = wanted <= places ? 1 : 0;
          free.length + crates.length < wanted && place <= places;
          place++
        )
          if (!crates.some((crate) => crate.place === place)) free.push(place)
        free.reverse().forEach((place, n) => {
          crates.push(crateAt(place, clock + n * 0.2, true))
        })
        crates.sort((a, b) => a.place - b.place)
        continue
      }
      const far = crates[crates.length - 1]
      if (far && crates.length > wanted) {
        if (taken && crates.length - wanted === 1 && far.place === places && where !== 'hands') {
          // The oldest has left the shelf: he shoves the row and it goes off the end.
          wants ??= { kind: 'shove', side, bench }
          continue
        }
        // Fewer in any other way: they hop and pop away where they stand, far end first.
        crates.splice(wanted).forEach((crate, n, popped) => {
          crate.leaving = 'pop'
          crate.left = clock + (popped.length - 1 - n) * 0.15
          bench.gone.push(crate)
        })
        continue
      }
      // A full chest at his hand with a free place down the bench is shoved along.
      if (taken && crates.length <= places && crates[0]?.full && clock - (crates[0]?.landed ?? 0) > 0.8)
        wants ??= { kind: 'shove', side, bench }
    }
    return wants
  }

  /**
   * The row is shoved one place along: every chest standing against the next from the entry
   * place outward. One pushed past the last place goes off the end of the bench, or, on the
   * longer plan, on through the hatch and out of sight, kept.
   */
  private push(side: number, clock: number): void {
    const bench = this.benches[side] as Bench
    const hatch = side === 0 && this.shelf.on
    bench.crates.forEach((crate, n) => {
      if (crate.place !== n) return
      crate.from = crate.place
      crate.place += 1
      crate.shoved = clock
    })
    const far = bench.crates[bench.crates.length - 1]
    if (far && far.place > (hatch ? PLACES + 1 : PLACES)) {
      far.leaving = hatch ? 'hatch' : 'fall'
      far.left = clock
      bench.gone.push(far)
      bench.crates.pop()
    }
  }

  /** One backup, where it is on its bench or on its way off it. `kept` has its latch lit. */
  private crate(view: View, side: number, crate: Crate, kept: boolean): void {
    const { clock, box } = view
    const age = clock - crate.landed
    if (age < 0) return
    const way = wayOf(side)
    const latch = crate.full && kept
    const leaving = crate.leaving === null ? -1 : clock - crate.left
    if (crate.leaving === 'pop' && leaving >= 0) {
      if (leaving < 0.4)
        chest(
          box,
          view.place(
            along(side, crate.place),
            BENCH_V[1],
            BENCH_H + 0.5 * Math.sin((leaving / 0.4) * Math.PI),
            0,
            1 - windup(leaving / 0.4),
          ),
          0,
          latch,
        )
      return
    }
    if (crate.leaving === 'fall') {
      // Off the end. Pushed with the row until nearly all of it is past the bench's end, it tips
      // over that edge, faster as it goes, sliding off it as it turns; comes down on its side on
      // the floor against the end of the bench, bounces once and pops away. Past the right
      // bench's end it is nearly out of sight, so there it pops as it goes over.
      const over = clamp((leaving - TIPS) / 0.4) ** 2
      const tip = (Math.PI / 2) * over
      const cos = Math.cos(tip)
      const sin = Math.sin(tip)
      // How far along its underside the edge it turns on is, from its middle.
      const held = 0.4 - 0.35 * over ** 1.5
      const bounce = clamp((leaving - TIPS - 0.4) / 0.2)
      toppled(
        view,
        leaving < TIPS
          ? along(side, lerp(crate.from, crate.place, overshoot(leaving / 0.3)))
          : along(side, PLACES + 0.5) + way * (held * cos + 0.45 * sin),
        BENCH_H - held * sin + 0.45 * cos + 0.12 * 4 * bounce * (1 - bounce),
        way,
        tip,
        1 - windup(clamp((leaving - (side === 0 ? 0.78 : 0.34)) / 0.2)),
        latch,
      )
      return
    }
    // Shoved, it goes a touch too far and comes back, and its lid jumps as it stops.
    const slid = clock - crate.shoved
    const u = along(side, lerp(crate.from, crate.place, overshoot(clamp(slid / 0.3))))
    // Through the hatch it is out of sight, and kept.
    if (crate.leaving === 'hatch' && slid > 0.3) return
    const landing = drop(age, 2)
    const thump = drop(0.36 + clock - crate.thumped, 0.4)
    const clunk = slid > 0.2 && slid < 0.4 ? Math.sin(((slid - 0.2) / 0.2) * Math.PI) * 0.12 : 0
    const open = Math.max(swung(crate.lid, clock) * (1 - 0.3 * thump.jolt), landing.jolt * 0.25, clunk)
    chest(box, view.place(u, BENCH_V[1], BENCH_H + landing.up + thump.up), open, latch)
    if (crate.full && open > 0.35) small(view, [u, ROW, BENCH_H + 0.06 + landing.up], view.facing(0), 0.85)
  }

  /** Everything as the demonstration has it, with nothing on its way anywhere. */
  private settle(told: Told, view: View, first: boolean): void {
    const { clock } = view
    const { server } = told
    const built = server !== 'gone'
    const lit = server === 'on' || server === 'restarting'
    this.built = built
    this.rack.settle(built ? 3 : 0, server === 'on' ? 'on' : server === 'restarting' ? 'booting' : 'off')
    this.lit = lit
    this.switched = SETTLED
    this.reboot = false
    this.tripped = server === 'fault'
    this.disk = { on: built, at: SETTLED }
    this.flap = { on: server === 'on' || server === 'trash', at: SETTLED }
    this.world = !built
      ? 'none'
      : server === 'trash'
        ? 'hands'
        : server === 'on' && !told.held
          ? 'over'
          : 'chest'
    this.how = 'popped'
    this.moved = SETTLED
    this.turned = view.facing(0)
    this.incoming = null
    this.ousted = SETTLED
    this.emptied = SETTLED
    this.back = told.back
    this.shelf = { on: told.kept > PLACES, at: SETTLED }
    this.job = null
    this.stirred = SETTLED
    // A sleeping chest is found with its breath in the air over it.
    this.breathes = server === 'asleep'
    this.breathFrom = clock - 3
    this.breathTo = SETTLED
    const at = server === 'trash' ? FRONT : HOME
    this.hand.x = at[0]
    this.hand.z = at[1]
    this.hand.pace = 0
    this.hand.route = []
    // Backups on their places, lids shut: the newest nearest him, and still at his hand only
    // where there is one more than the bench has places for.
    this.benches.forEach((bench, side) => {
      const count = side === 0 ? told.own : told.safety
      const places = side === 0 && this.shelf.on ? PLACES + 1 : PLACES
      const shown = Math.min(count, side === 0 && this.shelf.on ? places : places + 1)
      bench.count = count
      bench.gone = []
      bench.crates = Array.from({ length: shown }, (_, n) =>
        crateAt(shown > places ? n : n + 1, SETTLED, true),
      )
    })
    // The room opens in the middle of its own verb, 0.4 s before the newest of the day's backups
    // is shut: that chest at his hand with its lid up, and the copy in his hands over it. Held
    // for less motion it is the moment after: the copy in the chest, his hands at its rim.
    const [newest, ...older] = this.benches[0].crates
    const opens = (view.still ? !this.pressed : first) && server === 'asleep' && newest?.place === 1
    this.posed = opens && view.still
    if (opens && newest) {
      for (const crate of [newest, ...older]) {
        crate.place -= 1
        crate.from = crate.place
      }
      newest.lid = { on: true, at: SETTLED }
      if (!view.still) {
        newest.full = false
        this.job = { kind: 'copy', side: 0, asked: clock, at: clock - TURNED, next: null, crate: newest }
        this.hand.heading = headingOf(WAYS.left)
        this.tool = CARRY
        this.other = CARRY
      }
    }
  }

  /**
   * What the demonstration says, or, alone, the same values on a clock of its own: a day's play
   * and its backup, with the oldest pushed off the end; then a change that does not start, and
   * the world back from the copy taken before it. Alone it never restores an older backup and
   * never deletes. Handed back part-way through anything, it starts from the day's backup again.
   */
  private told(view: View): Told {
    const said = view.showing
    if (said) {
      this.alone = false
      const server = String(said.server)
      const back = String(said.back)
      const told: Told = {
        server: SERVERS.includes(server) ? (server as Server) : 'asleep',
        held: said.held === true && server === 'on',
        own: clamp(Math.round(Number(said.own) || 0), 0, 99),
        safety: clamp(Math.round(Number(said.safety) || 0), 0, 99),
        kept: Number(said.kept) > PLACES ? 14 : PLACES,
        back: back === 'own' || back === 'safety' ? back : 'none',
      }
      if (
        told.server !== OPENING.server ||
        told.own !== OPENING.own ||
        told.safety !== OPENING.safety ||
        told.kept !== OPENING.kept
      )
        this.pressed = true
      return told
    }
    // One held moment: asleep, with the day's backup just taken.
    if (view.still) return OPENING
    if (!this.alone) {
      this.alone = true
      this.round = ENTERS
      this.spare = Math.min(this.benches[1].count, PLACES + 1)
    }
    const before = this.round % ALONE
    this.round += view.dt
    const t = this.round % ALONE
    // Each round's change leaves one more chest on the right bench, which keeps three.
    if (before < 10.4 && t >= 10.4) this.spare += 1
    if (before < 5.2 && t >= 5.2) this.spare = Math.min(this.spare, PLACES)
    return {
      server:
        t < 2.6
          ? 'on'
          : t < 9
            ? 'asleep'
            : t < 11.8
              ? 'on'
              : t < 13.8
                ? 'restarting'
                : t < 16.4
                  ? 'fault'
                  : t < 20.5
                    ? 'on'
                    : 'asleep',
      held: t >= 9 && t < 11.1,
      own: t >= 3.9 && t < 5.2 ? PLACES + 1 : PLACES,
      safety: this.spare,
      kept: PLACES,
      back: t >= 15.1 && t < 20.5 ? 'safety' : 'none',
    }
  }
}

/**
 * Kit candidate: one arc that goes round a corner, `over` blocks above the straight line at its
 * top. `wide` goes along the room first and then in toward the back wall; otherwise out from the
 * wall first. It is how a world gets between the keeper's hands and the chest on the step without
 * passing through the rack's corner.
 */
const round = (a: Point, b: Point, t: number, over: number, wide: boolean): Point => {
  const leads = 1 - (1 - t) ** 2
  const lags = t * t
  return [
    lerp(a[0], b[0], wide ? leads : lags),
    lerp(a[1], b[1], wide ? lags : leads),
    lerp(a[2], b[2], t) + over * 4 * t * (1 - t),
  ]
}

/**
 * Kit candidate: where something carried in both hands is, in the room's terms, as the middle of
 * its underside: between his hands, and resting on them once they are overhead.
 */
function carried(hand: Body, arm: number): Point {
  const out = -0.62 * Math.sin(arm)
  const overhead = clamp((-arm - 1.9) / 0.5)
  return [
    hand.x + out * Math.sin(hand.heading),
    hand.z + out * Math.cos(hand.heading),
    1.38 - 0.62 * Math.cos(arm) - 0.22 + 0.32 * overhead,
  ]
}

/**
 * Kit candidate: a chest tipped over on its way off the end of a bench. `u` and `h` are where its
 * middle is, `way` is which way along the room it falls, and `tip` how far over it has gone, a
 * quarter turn on its side. It turns about its own middle, which a chest dropped by the kit
 * cannot.
 */
function toppled(
  view: View,
  u: number,
  h: number,
  way: number,
  tip: number,
  size: number,
  latch: boolean,
): void {
  if (size < 0.02) return
  const part = partsAt(view.box, view.place(u, ROW, h, (way * Math.PI) / 2, size))
  const cos = Math.cos(tip)
  const sin = Math.sin(tip)
  // Its face, with the latch, is still the one turned to the open wall.
  const face = -way * view.handed * 0.47
  part(0, -0.12 * cos, -0.12 * sin, 0.9, 0.66, 0.9, 128, Kind.chest, 0, tip)
  part(0, 0.33 * cos, 0.33 * sin, 0.9, 0.24, 0.9, 150, Kind.chest, 0, tip)
  part(
    face,
    -0.05 * cos,
    -0.05 * sin,
    0.05,
    0.16,
    0.14,
    latch ? 80 : 235,
    latch ? Kind.lamp : Kind.iron,
    latch ? LIT : 0,
    tip,
  )
}

/**
 * Kit candidate: the kit's breath with a beginning and an end, rising straight up (the sleep
 * room's, word for word). `since` is seconds since the chest began to breathe, so the first puff
 * leaves the lid then and the others follow it; `over` is seconds since it stopped (negative
 * while it goes on), and the puffs still in the air pop away.
 */
function breathing(box: View['box'], at: Place, since: number, over: number): void {
  if (since < 0 || over > 0.25) return
  const part = partsAt(box, at)
  const going = over > 0 ? 1 - windup(over / 0.25) : 1
  for (let n = 0; n < 3; n++) {
    const turns = since / 3.6 - n / 3
    if (turns < 0) continue
    const age = turns % 1
    const size = (0.12 + age * 0.2) * puff(age) * going
    if (size > 0.02) part((n - 1) * 0.05, 0.98 + age * 1.05, -0.45, size, size, size, 250, Kind.wool)
  }
}

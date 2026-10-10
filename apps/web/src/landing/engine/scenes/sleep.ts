// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Sleep: one server, its keeper, and one friend at a time.
 *
 * Asleep is how the server is found: the rack dark, and its small world shut in the chest beside
 * it, whose latch is the one lit thing in the room and whose lid breathes. The switch is the
 * pressure plate in the floor. A friend walks onto it and it sinks and lights; a pulse runs the
 * wire to the rack; the lamps come on tray by tray; the chest's lid is thrown open and the world
 * springs out to ride over the rack. Nobody throws anything to wake a server: somebody's weight
 * on the plate does.
 *
 * The keeper has the other half, putting the world to bed, and never leaves his spot between the
 * two chests. When the friend steps off, the plate springs up dark and his head follows them out
 * of the room. Only when they have gone does he turn to the chest, a hand on its raised lid, and
 * wait, looking back at the dark plate: those are the minutes after the last player, and the
 * world never leaves the rack before he has stood through them. Then it hops off, drops in and
 * bounces, he claps the lid shut over it, the latch lights, and only then do the lamps go out
 * from the top. A moment later the chest breathes.
 *
 * And the long rest: a copy of a world nobody plays is lifted out of its chest and carried to
 * the store chest, the copy is read back, and only then are the chest and the trays let go. A
 * join then finds no machine: its pulse dies in a spark at the bare footprint, a new chest drops
 * in and trays are pushed home while he fetches the world back out of storage.
 *
 * It follows the section's demonstration, which says `phase` ('asleep', 'copying', 'checking',
 * 'releasing', 'resting', 'starting', 'restoring', 'awake', 'empty', 'saving'), `step` (how far
 * a wake has got) and `copy` (there is a copy in storage). Those say where every part ends up;
 * the room gets there by its own causes (a friend on the plate, a pulse landed, the friend gone
 * and the keeper's wait stood, a world settled), so it may trail the demonstration by a beat or
 * two, and a move that has begun is never cut. Joined
 * part-way or held still, every part is simply as it should be. Alone, it plays a friend leaving
 * and the next one joining, round and round, and never the long rest.
 */

import { clamp, ease, lerp } from '../curves'
import { type Box, figure, KAI, MOSS, NOOR, type Skin, veiled } from '../models'
import {
  between,
  handsOf,
  headTo,
  type Point,
  PULSE,
  pulseIn,
  type RoomScene,
  runIn,
  slab,
  small,
  type View,
  wireIn,
  worker,
} from '../rooms'
import {
  chest,
  drop,
  lid,
  overshoot,
  type Place,
  partsAt,
  plate,
  puff,
  Rack,
  Rider,
  SETTLED,
  type Slot,
  smallWorld,
  swung,
  windup,
} from '../server'
import { type Body, bodyAt, headingOf, type Spot, STROLL, turn, walk } from '../walk'
import { Kind } from '../world'

/**
 * Where things stand, in the room's terms: the store chest, the keeper, the server's chest and
 * the rack in a row at one depth, and the plate out in front where a friend arrives.
 */
const RACK: Spot = [6.7, 3.1]
const CHEST: Spot = [4.95, 3.1]
const STORE: Spot = [3.05, 3.1]
const KEEPER: Spot = [4, 2.65]
const PLATE: Spot = [2.3, 5.2]
const EDGE: Spot = [2.3, 6.5]
const WIRE: readonly Spot[] = [
  [2.8, 5.2],
  [6.7, 5.2],
  [6.7, 3.1],
]
/** How long a pulse takes from the plate to the rack's foot. */
const TAKES = 6 / PULSE
/** The world's places: over the rack, this far above its top; in the server's chest; in the store chest. */
const OVER: Spot = [6.7, 2.15]
const RIDES = 0.6
const IN_CHEST: Point = [4.95, 2.65, 0.06]
const IN_STORE: Point = [3.05, 2.65, 0.56]
/** What a head turns to: the rack's lamps, the plate, where friends arrive, and into each chest. */
const LAMPS: Point = [6.7, 3.1, 1.2]
const WORLD: Point = [6.7, 2.6, 2.6]
const SWITCH: Point = [2.3, 5.2, 0]
const ARRIVALS: Point = [2.3, 6.5, 1.7]
const BED: Point = [4.95, 2.65, 0.6]
const STORED: Point = [3.05, 2.65, 1.3]
const FRIENDS: readonly Skin[] = [MOSS, KAI, NOOR]

/** A world sprung out of its chest is this long in the air. */
const SPRINGS = 0.45
/** A world put to bed slows on its spring, hops off the rack and falls; by `LANDS` it is in the chest. */
const SLOWS = 0.2
const FALLS = 0.6
/** How much of its fall it first hops up by. */
const HOPS = 0.87
const LANDS = SLOWS + FALLS
/**
 * The minutes after the last player, in the room's seconds: from the friend thinning away to the
 * world leaving the rack. Half a second for the keeper to turn and get a hand to the lid, and the
 * rest of it is his wait, which has to be seen.
 */
const WAITS = 1.2
/**
 * A copy carried from one chest to the other, in seconds from when he turns to the first: its lid
 * is lifted, a second world pops up into his hands, the lid falls shut, he turns right round (the
 * store chest's lid is thrown open as he comes to it), lowers it, lets go at the rim, and it is in.
 */
const LIFT = 0.35
const POP = 0.5
const SHUT = 0.65
const ROUND = 0.75
const THROWN = 1.1
const LOWER = 1.35
const LETGO = 1.6
const DONE = 1.75
/** How long his hand is on the store chest's lid, and his head dipped, before he lets it fall shut. */
const NODS = 0.45
/** The round it plays alone, and where in it the next friend joins. */
const ALONE = 17.4
const JOINS = 9.5

type Phase =
  | 'asleep'
  | 'copying'
  | 'checking'
  | 'releasing'
  | 'resting'
  | 'starting'
  | 'restoring'
  | 'awake'
  | 'empty'
  | 'saving'
const PHASES: readonly string[] = [
  'asleep',
  'copying',
  'checking',
  'releasing',
  'resting',
  'starting',
  'restoring',
  'awake',
  'empty',
  'saving',
]

interface Told {
  phase: Phase
  step: number
  copy: boolean
}

interface Friend extends Body {
  who: number
  /** How much of them is there yet: they thin in and out at the room's edge. */
  there: number
  /** Standing on the plate. */
  on: boolean
  leaving: boolean
  gaze: number
  nod: number
}

export class SleepScene implements RoomScene {
  private readonly rack = new Rack(3, 3, 'off')
  private readonly rider = new Rider()
  private readonly keeper = bodyAt(KEEPER, [0, 1])
  private was: Told | null = null
  /** When the demonstration last moved on to another phase. */
  private since = SETTLED
  /** A machine has been called for: a chest dropped in and trays pushed home, or both let go. */
  private machine = true
  /** It was called for by a pulse that found nothing there, and has not run since. */
  private rebuilt = false
  /** The server's chest, and its lid: there or thrown open, and since when. */
  private disk: Slot = { on: true, at: SETTLED }
  private diskLid: Slot = { on: false, at: SETTLED }
  /** The lamps, and when they were last switched. */
  private lit = false
  private switched = SETTLED
  /** The world: where it is, how it got there and when it set off, and how it lies in its chest. */
  private world: 'chest' | 'over' | 'none' = 'chest'
  private how: 'sprung' | 'dropped' | 'lowered' | 'popped' | 'spent' = 'popped'
  private moved = SETTLED
  private turned = 0
  /** The copy in the store chest: there or not, since when, and whether hands put it there. */
  private kept = false
  private keptAt = SETTLED
  private carried = true
  private storeLid: Slot = { on: false, at: SETTLED }
  /** That lid is up under his hand; when it was last wanted up; and when he let it fall. */
  private minded = false
  private read = SETTLED
  private shut = SETTLED
  /** A copy on its way between the chests in the keeper's hands: which way, and since when. */
  private job: { kind: 'store' | 'fetch'; at: number } | null = null
  private friend: Friend | null = null
  private joins = 0
  /** When the last friend thinned away to nothing. */
  private gone = SETTLED
  /** The plate: whether someone is on it, how far down it is, and when they stepped off. */
  private pressed = false
  private down = 0
  private released = SETTLED
  /** When the last pulse left the plate, and whether it found nothing at the end of its wire. */
  private sent = SETTLED
  private dud = false
  /** The chest's breath: whether it is breathing, when it began, and when it stopped. */
  private breathes = false
  private breathFrom = SETTLED
  private breathTo = SETTLED
  /** The keeper's arms and head, each moved to where it is wanted and never put there. */
  private tool = 0
  private other = 0
  private gaze = 0
  private nod = 0
  /** When he last had something to look at: he watches for friends by this. */
  private idle = 0
  /** The round it plays alone: seconds into it, and whether it is playing it. */
  private own = 0
  private alone = true

  step(view: View): void {
    const { clock, dt, box } = view
    const told = this.told(view)
    const first = this.was === null
    if (!first && told.phase !== this.was?.phase) {
      this.since = clock
      // A copy is always a new one: whatever older one was kept goes before it is brought.
      if (told.phase === 'copying' && this.kept && !this.job) this.keep(false, clock)
    }
    this.was = told
    const { phase } = told
    /** True on the frame the clock passes a moment. */
    const just = (when: number) => clock >= when && clock - dt < when

    // Where the phase has everything, once it has all finished moving.
    const stands = phase !== 'releasing' && phase !== 'resting'
    const joined = phase === 'starting' || phase === 'restoring' || phase === 'awake'
    const where = !stands ? 'none' : joined || phase === 'empty' ? 'over' : 'chest'
    const powered = where === 'over' || phase === 'saving'

    // Only changes are acted out; joined part-way or held still, every part is as it should be.
    if (first || view.still) this.settle(told, clock)

    // A copy that has reached the chest it was carried to is in it.
    const carry = this.job ? clock - this.job.at : 0
    if (this.job && carry >= DONE) {
      if (this.job.kind === 'store') this.keep(true, clock, true)
      else {
        this.world = 'chest'
        this.how = 'lowered'
        this.moved = clock
        this.turned = view.facing(Math.PI / 2)
      }
      this.job = null
    }
    const lifted =
      this.job && carry >= LIFT ? (carry < SHUT ? lid(true, carry - LIFT) : lid(false, carry - SHUT)) : 0

    // The friend: each join brings the next of the three. They thin in at the edge and walk one
    // leg straight onto the plate; no longer wanted, they turn round, step off and thin away.
    let friend = this.friend
    if (friend && !joined && !view.still) friend.leaving = true
    if (!friend && joined) {
      this.joins += 1
      friend = {
        ...bodyAt(EDGE, [0, -1]),
        who: this.joins,
        there: 0,
        on: false,
        leaving: false,
        gaze: 0,
        nod: 0,
      }
      this.friend = friend
    }
    if (friend) {
      const arrived = walk(friend, friend.leaving ? EDGE : PLATE, STROLL, dt)
      if (friend.leaving) friend.on = friend.on && Math.abs(friend.z - PLATE[1]) < 0.45
      else if (arrived) friend.on = true
      const going = friend.leaving && Math.abs(friend.z - EDGE[1]) < 0.5
      friend.there = clamp(friend.there + (going ? -dt : dt) / 0.4)
      if (going && arrived && friend.there <= 0) {
        this.friend = null
        this.gone = clock
      }
    }
    // The minutes after the last player: nobody is wanted on the server, and the last of them
    // has left the room. Until then the keeper only watches them go, and the world stays up.
    const left = this.friend === null && !joined

    // The plate is the switch: down and lit under whoever stands on it, up and dark the moment
    // they are off.
    const pressed = friend?.on === true
    if (pressed !== this.pressed) {
      this.pressed = pressed
      if (!pressed) this.released = clock
    }
    // (Not quite flush: pressed right home, its lit top lies in the same plane as its surround.)
    this.down += clamp((pressed ? 0.9 : 0) - this.down, -dt * 14, dt * 14)

    // Its pulses. One leaves as it is pressed, for a server that can be woken or a footprint with
    // nothing on it; with the server up, one every 2.4 s for as long as somebody is on it.
    const since = clock - this.sent
    if (
      pressed &&
      since > TAKES + 0.25 &&
      (this.lit ? since >= 2.4 : powered && (!this.machine || this.world === 'chest'))
    ) {
      this.sent = clock
      this.dud = false
    }
    if (just(this.sent + TAKES) && !this.lit) {
      const home = this.disk.on && this.rack.slots.every((slot) => slot.on && clock - slot.at > 0.7)
      if (!this.machine) {
        // It finds no machine and dies in a spark, which is what sets the rest going: a new
        // chest and trays, and the keeper off to the store chest for the world.
        this.dud = true
        this.machine = true
        this.rebuilt = true
        if (this.kept) this.job = { kind: 'fetch', at: clock }
      } else if (home && this.world === 'chest' && powered) {
        this.lit = true
        this.switched = clock
        this.rack.set('booting', clock)
      }
    }

    // A machine wanted with nobody on the way to wake it is simply put back. One no longer wanted
    // is let go only once its lamps are out, the store chest is shut and his hands are empty.
    if (stands && !this.machine && !joined) this.machine = true
    if (
      !stands &&
      this.machine &&
      !this.lit &&
      clock - this.switched > 0.7 &&
      this.world !== 'over' &&
      !this.job &&
      !this.storeLid.on &&
      clock - this.since > 0.7
    ) {
      this.machine = false
      this.rebuilt = false
    }
    if (this.machine !== this.disk.on && clock - this.disk.at > 0.5) {
      this.disk = { on: this.machine, at: clock }
      // A new chest's lid is thrown open by its landing; one let go shuts on its world and hops.
      if (this.machine) this.diskLid = { on: true, at: clock + 0.36 }
      else {
        if (this.diskLid.on) this.diskLid = { on: false, at: clock }
        if (this.world === 'chest') {
          this.world = 'none'
          this.how = 'popped'
        }
      }
    }
    this.rack.size(this.machine ? 3 : 0, clock)

    // The lamps: held lit while they boot, then each in its own time. Save, then stop: they go
    // out only once the world is shut in its chest.
    if (this.lit && this.rack.power === 'booting' && clock - this.switched > 1.1) this.rack.set('on', clock)
    const latched =
      this.disk.on && this.world === 'chest' && !this.diskLid.on && clock - this.diskLid.at >= 0.15
    if (this.lit && !powered && (latched || (this.world === 'none' && clock - this.moved > 0.3))) {
      this.lit = false
      this.switched = clock
      this.rack.set('off', clock)
    }
    const top = this.rack.draw(box, view.place(RACK[0], RACK[1]), clock)
    const rest = top - view.at(0, 0)[1] + RIDES
    // Warm light on the floor in front of lamps that are lit: it grows a tray at a time as they
    // boot, and goes with the last of them.
    const dark = clock - this.switched
    const glowing = this.lit
      ? Math.min(3, Math.floor(dark / 0.3) + 1)
      : dark < 0.18
        ? 3
        : dark < 0.4
          ? 2
          : dark < 0.62
            ? 1
            : 0
    view.light(RACK[0], RACK[1] + 0.9, 0.6, 4.5, (0.8 * glowing) / 3)

    // The world goes where it is wanted by its own move. It springs out of its chest once the
    // lamps are on (the bottom tray's, or all of them on a machine just built), throwing the lid
    // open as it leaves; it drops back in when the server is to sleep and everyone has gone;
    // with no machine left to run it, it pops away.
    const settled =
      this.world === 'chest' &&
      clock - this.moved > (this.how === 'dropped' ? LANDS : this.how === 'popped' ? 0.2 : 0) + 0.26
    if (
      settled &&
      where === 'over' &&
      this.lit &&
      !this.job &&
      clock - this.switched > (this.rebuilt ? 0.75 : 0.3)
    ) {
      this.world = 'over'
      this.how = 'sprung'
      this.moved = clock
      this.rebuilt = false
      if (!this.diskLid.on) this.diskLid = { on: true, at: clock }
      this.rider.spin = this.turned
      this.rider.whirl = 8
    } else if (
      this.world === 'over' &&
      clock - this.moved > 1.2 &&
      // To bed only once the keeper has stood his wait at the lid; with no machine left to run
      // it, as soon as nobody is standing on the plate.
      (where === 'chest'
        ? left && clock - this.gone > WAITS
        : where === 'none' && !pressed && clock - this.released > 0.3)
    ) {
      this.world = where
      this.how = where === 'chest' ? 'dropped' : 'spent'
      this.moved = clock
      // It comes to lie square in its chest.
      const square = view.facing(0)
      this.turned = square + Math.round((this.rider.spin - square) / (Math.PI / 2)) * (Math.PI / 2)
    } else if (this.world === 'none' && where !== 'none' && this.disk.on && !this.job) {
      // A chest put back with nobody to carry a world to it: one pops up in it.
      if (clock - this.disk.at > 0.8) {
        this.world = 'chest'
        this.how = 'popped'
        this.moved = clock
        this.turned = view.facing(0)
      }
    } else if (settled && where === 'chest' && this.diskLid.on) {
      // In, and staying: the lid is shut over it.
      this.diskLid = { on: false, at: clock }
    }
    const air = clock - this.moved
    // Sprung, it is caught by its spring where its arc ends.
    if (this.world === 'over' && this.how === 'sprung' && just(this.moved + SPRINGS)) {
      this.rider.settle(rest)
      this.rider.bob = 1.2
    }
    if (first || view.still) this.rider.settle(rest)
    this.rider.step(dt, rest, rest - 0.5, this.world === 'over' && where === 'over' ? 0.4 : 0)

    const diskUp = Math.max(swung(this.diskLid, clock), this.job?.kind === 'store' ? lifted : 0)
    const dropped = this.world === 'chest' && this.how === 'dropped'
    if (this.world === 'over' && this.how === 'sprung' && air < SPRINGS) {
      // One arc, up and then across so it clears the rack's corner: it goes a third of a block
      // past its height and comes back to it.
      const through = air / SPRINGS
      small(
        view,
        between(IN_CHEST, [OVER[0], OVER[1], rest], ease(through), overshoot(through)),
        this.rider.spin,
        lerp(0.85, 1, through),
      )
    } else if (this.world === 'over' || (dropped && air < SLOWS)) {
      small(view, [OVER[0], OVER[1], this.rider.ride], this.rider.spin, 1)
    } else if (dropped && air < LANDS) {
      // One arc: a hop up off the rack and out over its edge, and then down into the open chest.
      const through = (air - SLOWS) / FALLS
      small(
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
    } else if (this.world === 'chest' && this.disk.on && diskUp > 0.35) {
      // In a chest with its lid up it shows over the rim; it bounces as it lands, and one that
      // nobody brought pops up.
      const bounce =
        this.how === 'popped' ? 0 : drop(0.36 + air - (dropped ? LANDS : 0), dropped ? 1.5 : 0.6).up
      const size = this.how === 'popped' ? overshoot(clamp(air / 0.3)) : 1
      small(view, [IN_CHEST[0], IN_CHEST[1], IN_CHEST[2] + bounce], this.turned, 0.85 * size)
    } else if (this.world === 'none' && this.how === 'spent' && air < 0.25) {
      small(view, [OVER[0], OVER[1], this.rider.ride], this.rider.spin, 1 - windup(air / 0.25))
    }

    // The server's chest on its footprint. Dropped in, it bounces and its lid jumps; what lands
    // in it jolts the lid; let go, it hops and pops away. Its latch is lit while a world is shut
    // in it, and that is the one warm thing in a sleeping room.
    slab(view, RACK[0] - 0.98, RACK[1] - 1.88, RACK[0] + 0.98, RACK[1] - 0.02, 0, 0.05, 40, Kind.dark)
    slab(view, CHEST[0] - 0.43, CHEST[1] - 0.88, CHEST[0] + 0.43, CHEST[1] - 0.02, 0, 0.05, 40, Kind.dark)
    const stood = clock - this.disk.at
    if (this.disk.on) {
      const landing = drop(stood, 1.9)
      const thump =
        this.world === 'chest' && this.how !== 'popped' ? drop(0.36 + air - (dropped ? LANDS : 0), 1).jolt : 0
      chest(
        box,
        view.place(CHEST[0], CHEST[1], landing.up),
        diskUp * (1 - 0.25 * Math.max(landing.jolt, thump)),
        latched,
      )
    } else if (stood < 0.4) {
      chest(
        box,
        view.place(CHEST[0], CHEST[1], 0.5 * Math.sin((stood / 0.4) * Math.PI), 0, 1 - windup(stood / 0.4)),
        swung(this.diskLid, clock),
        false,
      )
    }
    // Asleep, it breathes: from a little after the last lamp is out until the first one is lit.
    const asleep = latched && !this.lit && clock - Math.max(this.switched, this.diskLid.at) > 1.2
    if (asleep !== this.breathes) {
      this.breathes = asleep
      if (asleep) this.breathFrom = clock
      else this.breathTo = clock
    }
    breathing(
      box,
      view.place(CHEST[0], CHEST[1]),
      clock - this.breathFrom,
      this.breathes ? -1 : clock - this.breathTo,
    )

    // The store chest on its slab. A copy goes into it in the keeper's hands, when the days
    // without play call for one and the world is shut in its own chest to be copied; otherwise it
    // pops up there, and one whose days have run out pops away, the lid jumping open for either.
    if (told.copy && !this.kept && !this.job) {
      if (phase !== 'copying') this.keep(true, clock)
      // Not before the server it is copied from has finished going to sleep: its lamps are out.
      else if (latched && !this.lit && clock - this.switched > 0.7) this.job = { kind: 'store', at: clock }
    } else if (!told.copy && this.kept && !this.job && clock - this.keptAt > 0.8) this.keep(false, clock)
    // Its lid is up under his hand for a copy coming in and while that copy is read back. Wanted
    // up no longer, whatever it is that ended the reading (the machine to be let go, or a friend
    // on the plate), it is he who shuts it: a hand to the lid, one nod into the chest, and down.
    // A copy that pops in or out by itself jumps the lid open and lets it fall.
    const filling =
      (this.job?.kind === 'store' && carry >= THROWN) ||
      phase === 'checking' ||
      (phase === 'copying' && this.kept)
    if (filling) {
      this.minded = true
      this.read = clock
    } else if (this.minded && clock - this.read >= NODS) {
      this.minded = false
      this.shut = clock
    }
    const closing = this.minded && !filling
    const open = this.minded || (!this.carried && clock - this.keptAt < 0.5)
    if (open !== this.storeLid.on) this.storeLid = { on: open, at: clock }
    // Its latch is lit while a world is in it, and blinks three times as that world is read back.
    const read = clock - Math.max(this.since, this.keptAt)
    const storeUp = Math.max(swung(this.storeLid, clock), this.job?.kind === 'fetch' ? lifted : 0)
    const copied = clock - this.keptAt
    slab(view, STORE[0] - 0.55, STORE[1] - 1, STORE[0] + 0.55, STORE[1] + 0.1, 0, 0.5, 150, Kind.cobble)
    chest(
      box,
      view.place(STORE[0], STORE[1], 0.5),
      storeUp,
      this.kept
        ? (this.carried || copied > 0.65) &&
            (phase !== 'checking' || (read < 1.2 && Math.floor(read / 0.2) % 2 === 1))
        : // One whose days ran out keeps its latch lit until it has popped away.
          !this.carried && copied < 0.3,
    )
    const size = this.kept
      ? this.carried
        ? 1
        : overshoot(clamp((copied - 0.1) / 0.3))
      : this.carried
        ? 0
        : 1 - windup(clamp((copied - 0.15) / 0.25))
    if (storeUp > 0.35 && size > 0.02) small(view, IN_STORE, view.facing(0), 0.85 * size)

    // The wire from the plate to the rack's foot, and whatever is on its way along it.
    wireIn(view, WIRE)
    if (view.still) pulseIn(view, WIRE, this.lit ? 0.45 : 0)
    else runIn(view, WIRE, since, this.dud)
    plate(box, view.place(PLATE[0], PLATE[1]), this.down)

    // The keeper turns on his spot to what he has to do: to the store chest to read a copy back
    // and shut it in, to the server's chest to put its world to bed and to watch a machine come
    // or go, and otherwise to the open wall, where friends arrive.
    const keeper = this.keeper
    const waiting = this.world === 'over' && where !== 'none' && left
    const shutting = dropped && (this.diskLid.on || clock - this.diskLid.at < 0.4)
    const tending = this.disk.on && (waiting || shutting)
    const moving =
      (this.machine && !stands) ||
      clock - this.disk.at < 0.9 ||
      this.rack.slots.some((slot) => clock - slot.at < 0.9)
    const face = this.job
      ? carry < ROUND === (this.job.kind === 'store')
        ? 'chest'
        : 'store'
      : this.minded || clock - this.shut < 0.25
        ? 'store'
        : tending || moving || this.rebuilt
          ? 'chest'
          : 'wall'
    keeper.want = headingOf(face === 'wall' ? [0, 1] : face === 'chest' ? [1, 0] : [-1, 0])
    if (first || view.still) keeper.heading = keeper.want
    const faced = turn(keeper, dt)

    // His head goes first, to whatever just happened: to a friend coming, and after one going
    // until they are out of the room; back to the dark plate while he waits at the lid; up to the
    // world as it hops and down into the chest after it; along the wire with a pulse; to the lamps.
    // With nothing to look at he watches for friends: every five seconds, for a second and a half.
    // At the store chest, or with a world in his hands, it is simply down on what he is doing.
    const busy = this.job !== null || face === 'store'
    let look: Point | null = null
    if (tending) look = !shutting ? SWITCH : air < SLOWS + 0.3 ? WORLD : BED
    else if (this.rebuilt || moving) look = LAMPS
    else if (!this.lit && since < TAKES + (this.dud ? 0.4 : 0)) {
      const along = Math.min(6, since * PULSE)
      look = along < 3.9 ? [2.8 + along, 5.2, 0] : [6.7, 9.1 - along, 0]
    } else if (friend && (friend.leaving || !friend.on)) look = [friend.x, friend.z, 1.7]
    else if (this.lit) look = WORLD
    else if (dark < 1) look = LAMPS
    else if (!this.carried && copied < 0.9) look = STORED
    else {
      const watch = (clock - this.idle) % 5
      if (view.still || (watch >= 1.5 && watch < 3)) look = ARRIVALS
    }
    if (busy || tending || moving || this.rebuilt || friend || this.lit || dark < 1) this.idle = clock
    // Over the store chest it is tipped well down, and dips once more as he shuts it: his nod.
    const bent = this.job
      ? 0.3
      : 0.45 + (closing ? 0.3 * Math.sin(clamp((clock - this.read) / NODS) * Math.PI) : 0)
    const [gaze, nod] = busy ? [0, bent] : look ? headTo(keeper, look, view.handed, 0.5) : [0, 0]
    this.gaze += clamp(gaze - this.gaze, -dt * 5, dt * 5)
    this.nod += clamp(nod - this.nod, -dt * 3, dt * 3)
    if (first || view.still) {
      this.gaze = gaze
      this.nod = nod
    }

    // His hands touch only lids and worlds. One goes to the lid he is at, and comes down with it
    // as it shuts; both hold a world he carries, up over the rim it has to clear.
    let near = 0
    let far = 0
    if (this.job) {
      const storing = this.job.kind === 'store'
      if (carry < POP) near = carry > 0.1 ? (storing ? -1.55 : -1.9) : 0
      else {
        near = carry < LOWER ? (storing ? -1.85 : -1.75) : storing ? -1.6 : -1
        far = near
      }
    } else if (closing && faced) near = -1.9
    else if (tending && faced) near = -0.7 - 0.85 * clamp(diskUp)
    // The arm on the camera's side, whichever way he faces, so the hand is seen on the lid.
    const nearest = (face === 'store') !== view.handed < 0
    const pace = dt * (shutting || clock - this.shut < 0.25 ? 10 : 6)
    this.tool += clamp((nearest ? near : far) - this.tool, -pace, pace)
    this.other += clamp((nearest ? far : near) - this.other, -pace, pace)
    worker(view, keeper, { tool: this.tool, other: this.other, gaze: this.gaze, nod: this.nod })

    // The copy in his hands: it pops up out of the world in the chest he is at, a little past his
    // hands and back, goes round with him, and is let go at the other chest's rim.
    if (this.job && carry >= POP) {
      const storing = this.job.kind === 'store'
      const from = storing ? IN_CHEST : IN_STORE
      const to = storing ? IN_STORE : IN_CHEST
      const [hx, hy, hz] = handsOf(view, keeper, this.tool)
      const [ax, ay, az] = view.at(from[0], from[1], from[2])
      const [bx, by, bz] = view.at(to[0], to[1], to[2])
      const up = overshoot(clamp((carry - POP) / 0.2))
      const fall = clamp((carry - LETGO) / (DONE - LETGO))
      smallWorld(
        box,
        {
          x: lerp(lerp(ax, hx, up), bx, fall),
          y: lerp(lerp(ay, hy - 0.2, up), by, fall * fall),
          z: lerp(lerp(az, hz, up), bz, fall),
          heading: view.facing(keeper.heading),
          inside: view.inside,
          scale: lerp(0.6 * clamp((carry - POP) / 0.08, 0.3), 0.85, fall),
        },
        'survival',
        clock,
      )
    }

    // The friend, from behind: on the plate they turn to the rack as it comes up, and once the
    // world is out they look up at it.
    if (friend) {
      const sees: Point | null =
        !friend.on || friend.leaving
          ? null
          : this.world === 'over'
            ? [OVER[0], OVER[1], rest + 0.5]
            : this.lit || this.rebuilt
              ? LAMPS
              : null
      const [turns, tips] = sees ? headTo(friend, sees, view.handed, 0.5) : [0, 0]
      friend.gaze += clamp(turns - friend.gaze, -dt * 4, dt * 4)
      friend.nod += clamp(tips - friend.nod, -dt * 3, dt * 3)
      if (first || view.still) {
        friend.gaze = turns
        friend.nod = tips
      }
      figure(
        veiled(box, ease(friend.there)),
        view.stance(friend, STROLL),
        FRIENDS[friend.who % FRIENDS.length] ?? MOSS,
        { gaze: friend.gaze, nod: friend.nod },
      )
    }
  }

  /** A copy pops up in the store chest or away out of it, or, `carried`, was lowered in by hand. */
  private keep(kept: boolean, clock: number, carried = false): void {
    this.kept = kept
    this.keptAt = clock
    this.carried = carried
  }

  /** Everything as the demonstration has it, with nothing on its way anywhere. */
  private settle(told: Told, clock: number): void {
    const { phase, step } = told
    const built = phase !== 'releasing' && phase !== 'resting' && !(phase === 'restoring' && step < 1)
    const running =
      phase === 'awake' ||
      phase === 'empty' ||
      phase === 'saving' ||
      (phase === 'starting' && step >= 2) ||
      (phase === 'restoring' && step >= 3)
    // A friend who is leaving is found still on the plate, about to turn and step off it.
    const friend = phase === 'starting' || phase === 'restoring' || phase === 'awake' || phase === 'empty'
    this.machine = built
    this.rebuilt = phase === 'restoring' && !running
    this.disk = { on: built, at: SETTLED }
    this.diskLid = { on: running || this.rebuilt, at: SETTLED }
    this.rack.settle(built ? 3 : 0, running ? 'on' : 'off')
    this.lit = running
    this.switched = SETTLED
    this.world = !built ? 'none' : running ? 'over' : 'chest'
    this.how = 'popped'
    this.moved = SETTLED
    this.keep(told.copy, SETTLED, true)
    this.storeLid = { on: phase === 'checking', at: SETTLED }
    this.minded = phase === 'checking'
    this.read = clock
    this.shut = SETTLED
    this.gone = SETTLED
    this.job = null
    this.friend = friend
      ? {
          ...bodyAt(PLATE, [0, -1]),
          who: this.joins,
          there: 1,
          on: true,
          leaving: false,
          gaze: 0,
          nod: 0,
        }
      : null
    this.pressed = friend
    this.down = friend ? 0.9 : 0
    this.released = SETTLED
    this.sent = SETTLED
    this.dud = false
    // A sleeping chest is found with its breath in the air over it.
    this.breathes = built && !running && !this.rebuilt
    this.breathFrom = clock - 3
    this.breathTo = SETTLED
    this.tool = 0
    this.other = 0
  }

  /**
   * What the demonstration says, or, alone, a round of its own. That opens on the sleep: the
   * server up and a friend turning to step off the plate. Handed back part-way through anything,
   * the next thing that happens is a join, played from wherever the room is.
   */
  private told(view: View): Told {
    const said = view.showing
    if (said) {
      this.alone = false
      const phase = String(said.phase)
      return {
        phase: PHASES.includes(phase) ? (phase as Phase) : 'asleep',
        step: Number(said.step) || 0,
        copy: said.copy === true,
      }
    }
    // One held moment: asleep, which is the heading.
    if (view.still) return { phase: 'asleep', step: 0, copy: false }
    if (!this.alone) {
      this.alone = true
      this.own = JOINS
    }
    this.own += view.dt
    const t = this.own % ALONE
    // Whatever copy the room was left with stays in the store chest: alone, it never rests.
    const copy = this.kept
    if (t < 3.5) return { phase: 'empty', step: 0, copy }
    if (t < 5) return { phase: 'saving', step: 0, copy }
    if (t < JOINS) return { phase: 'asleep', step: 0, copy }
    if (t < 12.9) return { phase: 'starting', step: t < 10.8 ? 0 : t < 11.9 ? 1 : 2, copy }
    return { phase: 'awake', step: 0, copy }
  }
}

/**
 * Kit candidate: the kit's breath with a beginning and an end, rising straight up. `since` is
 * seconds since the chest began to breathe, so the first puff leaves the lid then and the others
 * follow it; `over` is seconds since it stopped (negative while it goes on), and the puffs still
 * in the air pop away. The kit's own drifts half a block to the chest's side as it rises and to
 * the height of the rack's top, which here carries it either onto the keeper's shoulder or up
 * against the rack, where it reads as the machine's: seen from the open wall there is well under
 * a block between the two. This one stays over the middle of the lid it comes from, each puff a
 * touch to one side of the last so they are three puffs and not a pole, and stops short of the
 * rack's top.
 */
function breathing(box: Box, at: Place, since: number, over: number): void {
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

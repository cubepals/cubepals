/**
 * The machine: one server, built for one world.
 *
 * Before anything is made there is only the world it will be for, sitting on a plate on a bare
 * footprint, and the worker with a hand on a lever. The worker never leaves that spot, does
 * nothing the server did not cause, and looks at a thing before he puts a hand to it.
 *
 * A start on a bare footprint builds the server, each part at its own step: the lever is thrown
 * and the word runs along the wire; the frame rises under the world, bay on bay; its disk, a
 * chest, drops in beside it; trays are pushed home and its cores, a furnace each, land and light;
 * the lamps come on; the world is spun up on its plate, and at the end it lifts off and rides over
 * the rack. A machine that stands is not built twice: a second go only starts it. A start that
 * stops is the opposite, at once: every lamp flashes and goes dark, smoke, the lever springs back,
 * the fires sink, and the worker reads the rack and slaps a notice on the sign. A different world
 * gets a different machine: what stands is taken down the way it went up, and the world on the
 * bare plate is swapped.
 *
 * It follows the section's demonstration, which says: `gb` (3, 4 or 8), `cores` (1, 2 or 4),
 * `modded`, `step` ('idle', then the start's own steps, then 'online') and `fault`. The room may
 * trail those by a beat and never runs ahead; joined part-way or held still, every part is simply
 * as it should be, and only changes are acted out. Left alone it gives itself the same values on
 * a clock.
 */
import { LIT } from '../chunk'
import { clamp } from '../curves'
import { flight, type Point, type RoomScene, runIn, type View, wireIn, worker } from '../rooms'
import {
  board,
  chest,
  drop,
  furnace,
  lever,
  lid,
  overshoot,
  type Power,
  partsAt,
  Rack,
  Rider,
  SETTLED,
  type Slot,
  sequence,
  slap,
  slip,
  slotsOf,
  smallWorld,
  UNIT,
  windup,
} from '../server'
import { bodyAt, reach, type Spot } from '../walk'
import { Kind } from '../world'

/** The start's steps in order; `idle` is before any of them. */
const STEPS = [
  'queued',
  'allocating',
  'storage',
  'compute',
  'booting',
  'starting',
  'loading_world',
  'verifying',
  'access',
  'online',
] as const
const IDLE = -1
const QUEUED = 0
const ALLOCATING = 1
const STORAGE = 2
const COMPUTE = 3
const BOOTING = 4
const STARTING = 5
const LOADING = 6
const VERIFYING = 7
const ONLINE = 9

/** Where things stand, in the room's terms: everything faces the open wall, in one row. */
const RACK: Spot = [5, 3.5]
const PLATE: Spot = [5, 2.55]
const CHEST: Spot = [6.75, 3.5]
const FURNACES: readonly Point[] = [
  [8, 3.5, 0],
  [8, 3.5, 1],
  [9, 3.5, 0],
  [9, 3.5, 1],
]
/** The marks on the floor where the parts will stand: the middle of each, and how wide it is. */
const FOOTPRINTS: readonly Point[] = [
  [5, 2.5, 1.96],
  [6.75, 3.05, 0.86],
  [8, 3, 0.96],
]
const LEVER: Spot = [2.5, 4.3]
/**
 * The sign stands behind the post, over the lever: where its pole is, how long that is, and how
 * high up the pole a notice goes. Its face is just behind the arm he works with, so the hand that
 * puts a notice on it is seen against it, and from the open wall it stands clear of his face.
 */
const SIGN: Spot = [2.5, 3.75]
const POLE = 1.4
const NOTICE = 1.7
/** Where on the sign his hand lands: the near edge of the notice, in line with that arm. */
const SLAPS: Point = [2.4, 3.94, 1.65]
/** Where a notice knocked off the sign comes down: the bare floor between the post and the rack. */
const SHED: Point = [3.4, 3.9, 0]
const WORKER: Spot = [1.85, 4.3]
/** How high his eyes are, for what he looks at. */
const EYES = 1.7
/** The redstone: a run along the front, with a branch back to each part. */
const RUN: readonly Spot[] = [
  [2.8, 4.3],
  [8, 4.3],
]
const TO_RACK: readonly Spot[] = [
  [2.8, 4.3],
  [5, 4.3],
  [5, 3.55],
]
const TO_CHEST: readonly Spot[] = [
  [6.75, 4.3],
  [6.75, 3.55],
]
const TO_FIRE: readonly Spot[] = [
  [8, 4.3],
  [8, 3.55],
]
/** What runs on it while the server does: fire to the rack, and the rack to its disk. */
const WORK: readonly { path: readonly Spot[]; every: number; late: number }[] = [
  {
    path: [
      [8, 3.55],
      [8, 4.3],
      [5, 4.3],
      [5, 3.55],
    ],
    every: 3.4,
    late: 0.3,
  },
  {
    path: [
      [5, 3.55],
      [5, 4.3],
      [6.75, 4.3],
      [6.75, 3.55],
    ],
    every: 4.6,
    late: 1.6,
  },
]

/** How long his head is on the lever before his hand moves it: head first, then hand. */
const LOOKS = 0.35
/** How long the lever takes to go over under his hand, and to be lifted back: a reach, then the pull. */
const THROWS = 0.3
const REACHES = 0.2
const LIFTS = 0.5
/** How close two steps of a start may follow one another when the room has catching up to do. */
const APACE = 0.3
/**
 * How long a stopped rack is read before its sentence goes up on the sign, and how long before
 * that his arm sets out for it: as long as the arm takes to get there.
 */
const READS = 2.5
const RAISES = 0.35
/** A world swapped: how long the one that is there takes to go, and the whole of it. */
const GOES = 0.22
const SWAPS = 0.5
/** How far over the rack's top the world's underside rides: its middle is 0.95 over it. */
const RIDES = 0.55
/** His arm: on the handle, pushed out after it, and up at the sign with the hand on the notice. */
const HOLDS = -1.05
const PUSHES = -1.35
const POSTS = -2
/** The round it plays alone. */
const ROUND = 36

interface Told {
  trays: number
  cores: number
  modded: boolean
  /** How far the start has got: -1 before one, then the step's place in the list. */
  i: number
  fault: boolean
}

export class MachineScene implements RoomScene {
  /** The server: a frame of bays, with trays in them once it has been fitted. */
  private readonly rack = new Rack(0, 5, 'off', 0, 0)
  private readonly cores: Slot[] = slotsOf(0, 4)
  private readonly disk: Slot = { on: false, at: SETTLED }
  private readonly hand = bodyAt(WORKER, [1, 0])
  private readonly world = new Rider()
  private seen = false
  /** Which world is on the plate: the one with the cog, or the one with the tree. */
  private kind = false
  /** What the room has got to: the step, whether it stopped there, and whether the lever is over. */
  private at = IDLE
  private stopped = false
  private over = false
  /** What has been made of the machine, each part at its own step, and stands until taken down. */
  private framed = false
  private chested = false
  private fitted = false
  /** The size it is being made: the trays and the furnaces the answers asked for this world. */
  private trays = 3
  private fires = 1
  /** When each thing last happened, on the scene's clock. */
  private threw = SETTLED
  private lifted = SETTLED
  private faulted = SETTLED
  private stepped = SETTLED
  private caught = SETTLED
  private clapped = SETTLED
  private lidded = SETTLED
  private switched = SETTLED
  private busy = SETTLED
  private quiet = SETTLED
  private posted = SETTLED
  private torn = SETTLED
  private swapped = SETTLED
  private raised = SETTLED
  private rose = SETTLED
  /** How high the fires burn, how tall the rack stood a frame ago, and how many bays it had. */
  private heat = 0
  private tall = 0
  private bays = 0
  /** The world has left its place over the rack and has not yet landed on its plate. */
  private sinks = false
  /** How long the world on the plate has spent turning: its cog turns with it, and stops with it. */
  private cog = 0
  /** Where his head is turned, and how far it is tipped. */
  private gaze = 0
  private nod = 0
  /** The lever is about to be moved by his hand; and since when his head has been on it, if it is. */
  private minds = false
  private eyed: number | null = null
  /** The round it plays alone starts in the middle of the build. */
  private own = 2.5

  step(view: View): void {
    const { clock, dt, box } = view
    const told = this.told(view)
    const settled = !this.seen || view.still
    this.seen = true
    /** True on the frame the clock passes a moment. */
    const just = (when: number) => clock >= when && clock - dt < when

    // Only changes are acted out; joined part-way or held still, every part is simply as it
    // should be.
    if (settled) this.settle(view, told)
    else this.follow(told, clock)
    const running = this.at >= COMPUTE && !this.stopped
    const loaded = this.at >= LOADING && !this.stopped
    const riding = this.at >= ONLINE && !this.stopped

    // The marks on the floor where it will stand, there before any of it is.
    for (const [u, v, wide] of FOOTPRINTS) {
      const [x, y, z] = view.at(u, v)
      box(x - wide / 2, y, z - wide / 2, wide, 0.05, wide, 15, Kind.dark, 0, view.inside)
    }

    // The server: bays, then trays in them, a part at a time. Its lamps say the rest: dark, on
    // from the bottom tray up, each in its own time, or all flashing together at a stop.
    if (!settled) {
      this.rack.frame(this.framed ? this.trays : 0, clock)
      // Built or taken down, its trays follow one another faster than a change of size slides
      // them, and so do the furnaces.
      const building = this.over && this.at >= COMPUTE
      if (!this.fitted) sequence(this.rack.slots, 0, clock, 0.2)
      else if (building) sequence(this.rack.slots, Math.min(this.trays, this.rack.standing), clock, 0.25)
      else this.rack.size(this.trays, clock)
      sequence(this.cores, this.fitted ? this.fires : 0, clock, building ? 0.25 : 0.3)
    }
    const power: Power = this.stopped
      ? clock - this.faulted < 1.5
        ? 'fault'
        : 'off'
      : this.at >= STARTING
        ? 'on'
        : this.at === BOOTING
          ? 'booting'
          : 'off'
    if (!view.still) {
      // The light on the floor keeps the time the rack's own lamps go by: booted, it goes on
      // without booting again, and stopped by a fault it is dark already, with nothing to put out.
      const from = this.rack.power
      if (power !== from && !(from === 'booting' && power === 'on'))
        this.switched = from === 'fault' ? SETTLED : clock
      this.rack.set(power, clock)
    }
    const [, floor] = view.at(RACK[0], RACK[1])
    const top = this.rack.draw(box, view.place(RACK[0], RACK[1]), clock)
    const sinking = top - floor < this.tall - 0.0001
    this.tall = top - floor

    // The world it is built for, on its plate: on the floor until there is a frame to carry it up,
    // still until it is loaded, spun up while it loads, and lifted off to ride once it is online.
    // Whatever is done to the machine under it bumps it.
    if (this.rack.standing !== this.bays && !settled) {
      this.raised = clock
      if (this.rack.standing > this.bays) this.world.bob += 1.4
    }
    this.bays = this.rack.standing
    for (const tray of this.rack.slots) {
      if (tray.on && just(tray.at + 0.64)) this.world.bob += 1.2
      if (!tray.on && just(tray.at + 0.5)) this.world.bob += 0.4
    }
    const base = Math.max(top, floor + 0.05)
    const [px, , pz] = view.at(PLATE[0], PLATE[1])
    box(
      px - 0.45,
      base,
      pz - 0.45,
      0.9,
      0.1,
      0.9,
      loaded ? 80 : 150,
      loaded ? Kind.lamp : Kind.iron,
      loaded ? LIT : 0,
      view.inside,
    )
    const sits = base + 0.1
    const rest = riding ? top + RIDES : sits
    if (settled) this.world.settle(rest)
    this.world.step(dt, rest, sits, riding ? 0.4 : loaded ? 2.4 : 0)
    if (this.sinks && this.world.ride <= sits + 0.001) {
      // Let down onto its plate, it bounces once.
      this.sinks = false
      this.world.bob = 1.3
    } else if (!riding && !this.sinks) {
      // On its plate it is never more than a hop above it, and it rides the top down as bays sink.
      this.world.ride = Math.min(this.world.ride, sits + (sinking ? 0.05 : 0.25))
    }
    // The kit turns the cog on a modded world by the time it is given, so it is given the time
    // this world has spent turning: a world that sits still has a still cog. Riding, the cog keeps
    // the kit's own pace; spun up, twice that and no more.
    this.cog += dt * Math.min(2, Math.abs(this.world.whirl) / 0.4)
    // Swapped, the one that is there gathers itself and is gone, and the other pops out of where
    // it was.
    const swap = clock - this.swapped
    smallWorld(
      box,
      {
        x: px,
        y: this.world.ride,
        z: pz,
        heading: this.world.spin,
        inside: view.inside,
        scale: swap < GOES ? 1 - windup(swap / GOES) : overshoot(clamp((swap - GOES) / (SWAPS - GOES))),
      },
      this.kind ? 'create' : 'survival',
      this.cog,
    )

    // Its disk: dropped in beside the frame, its lid jumping as it lands. The lid is thrown open
    // when the world is loaded and stays up; it claps once when a machine that stands is started,
    // and claps shut at a stop. Its latch is never lit: no world is ever put in it here.
    const disked = clock - this.disk.at
    if (this.disk.on) {
      const landing = drop(disked, 2)
      const clap = clock - this.clapped
      if (just(this.disk.at + 0.36)) this.landed(view, [CHEST[0], CHEST[1] - 0.45, 0])
      chest(
        box,
        view.place(CHEST[0], CHEST[1], landing.up),
        Math.max(
          landing.jolt * 0.3,
          clap < 0.5 ? Math.sin((clap / 0.5) * Math.PI) : 0,
          lid(loaded, clock - this.lidded),
        ),
      )
    } else if (disked < 0.4) {
      // Not wanted, it hops and pops away.
      const hop = 0.5 * Math.sin((disked / 0.4) * Math.PI)
      chest(box, view.place(CHEST[0], CHEST[1], hop, 0, 1 - windup(disked / 0.4)))
    }

    // Its cores: each drops onto its place and bounces, and fire catches in its mouth as it lands,
    // or, on a machine that stands, one after another when the start gets to them. A stop sinks
    // the fires to embers; the lever lifted puts them out.
    const warmth = running ? 1 : this.stopped && this.at >= COMPUTE ? 0.3 : 0
    this.heat = settled ? warmth : this.heat + (warmth - this.heat) * (1 - Math.exp(-dt * 9))
    this.cores.forEach((core, n) => {
      const age = clock - core.at
      if (!core.on && age > 0.5) return
      const [u, v, h] = FURNACES[n] as Point
      if (core.on && just(core.at + 0.36)) {
        this.landed(view, [u, v - 0.5, h])
        this.world.bob += 0.5
      }
      const lit = clock - Math.max(this.caught + n * 0.12, core.at + 0.36)
      furnace(
        box,
        view.place(
          u,
          v,
          h + (core.on ? drop(age, 1.7).up : 0),
          0,
          core.on ? overshoot(clamp(age / 0.14)) : 1 - windup(clamp((age - 0.22) / 0.26)),
        ),
        !core.on || lit < 0 ? 0 : this.heat + (running ? Math.exp(-lit * 5) : 0),
        clock,
        n,
      )
    })

    // The lever on its post. His hand throws it over toward the rack and it lands with a clunk;
    // his hand lifts it back; a stop springs it back by itself, and it rebounds off its rest.
    const throwing = clock - this.threw
    const lifting = clock - this.lifted
    const stop = clock - this.faulted
    const thrown = this.over
      ? clamp(throwing / THROWS) ** 2
      : stop < lifting
        ? stop < 0.1
          ? 1 - (stop / 0.1) ** 2
          : stop < 0.34
            ? 0.3 * Math.sin(((stop - 0.1) / 0.24) * Math.PI)
            : 0
        : 1 - clamp((lifting - REACHES) / (LIFTS - REACHES)) ** 2
    const clunk = this.over ? throwing - THROWS : stop < lifting ? stop - 0.1 : lifting - LIFTS
    const jolt = clunk > 0 && clunk < 0.2 ? 0.04 * Math.sin(clunk * 60) * (1 - clunk / 0.2) : 0
    lever(box, view.place(LEVER[0] + jolt, LEVER[1], 0, view.handed < 0 ? Math.PI : 0), thrown, true)
    if (this.over && just(this.threw + THROWS)) {
      const [x, y, z] = view.at(LEVER[0], LEVER[1])
      view.chips([x - 0.5, y, z - 0.5], [0, 0.6, 0], 2, 0.2)
    }
    // The sign over it, and the sentence: a notice slapped on once the stopped rack has been
    // read. The clunk of the lever next thrown shakes the sign and knocks it off.
    const sign = view.place(SIGN[0], SIGN[1])
    const torn = this.torn > this.posted ? clock - this.torn : -1
    board(box, sign, 0.8, 0.6, POLE, slap(clock - this.posted) + slap(torn))
    if (torn >= 0) shed(view, [SIGN[0], SIGN[1] + 0.08, NOTICE], SHED, 0.6, 0.4, torn)
    else if (this.posted !== SETTLED) slip(box, sign, 0, NOTICE, 0.6, 0.4, clock - this.posted)

    // The wire along the front, dark unless something is on it: the word of a start from the
    // lever to the footprint, and then the work, for as long as the server runs. A pulse that has
    // set out runs to its end.
    wireIn(view, RUN)
    wireIn(view, [TO_RACK[1] as Spot, TO_RACK[2] as Spot])
    wireIn(view, TO_CHEST)
    wireIn(view, TO_FIRE)
    runIn(view, TO_RACK, throwing - THROWS)
    const until = this.at >= STARTING && !this.stopped ? clock : this.quiet
    for (const { path, every, late } of WORK) {
      const worked = clock - this.busy - late
      if (worked >= 0 && clock - (worked % every) <= until) runIn(view, path, worked % every)
    }

    // Warm light on the floor in front of whatever is lit: the fires, and the trays whose lamps
    // are on. It comes a tray at a time and goes with the last lamp.
    const trays = Math.max(1, this.rack.trays)
    const since = clock - this.switched
    const glowing =
      power === 'on' || power === 'booting'
        ? Math.min(trays, Math.floor(since / 0.3) + 1)
        : power === 'off'
          ? Math.max(0, trays - 1 - Math.floor(since / 0.22))
          : 0
    view.light(5.5, 4.2, 1.6, 5.5, (this.heat > 0.6 ? 0.3 : 0) + (0.6 * glowing) / trays)

    // The worker. A hand on the handle whenever the lever is off; pushed out after it as it is
    // thrown, and let go when the frame starts up; out to it again to lift it back. At a stop the
    // arm stays down until the rack has been read, goes up to the sign so that the hand lands on
    // it as the notice does, rests there while the notice settles, and comes back to the handle.
    const hand = this.hand
    const arm = this.stopped
      ? stop < READS - RAISES
        ? 0
        : stop < READS + 0.25
          ? POSTS
          : HOLDS
      : this.over
        ? this.at < ALLOCATING
          ? PUSHES
          : 0
        : lifting < REACHES
          ? PUSHES
          : HOLDS
    if (settled) hand.arm = arm
    else reach(hand, arm, dt, 6)

    // His head goes to whatever the server is doing: the part that last moved, the lamps as they
    // climb, the world when it turns. At a stop it is up to the smoke, down the rack in two small
    // nods, and over to the sign a beat before his arm goes up to it; then back to the dark rack.
    // It is on the lever from a beat before his hand moves it until the lever is home.
    const face = (h: number): Point => [RACK[0], RACK[1], h]
    const above: Point = [PLATE[0], PLATE[1], this.world.ride - floor + 0.5]
    let tray = -1
    let latest = clock - 1
    this.rack.slots.forEach((slot, n) => {
      if (slot.at > latest) {
        latest = slot.at
        tray = n
      }
    })
    const core = this.cores.findIndex((each) => clock - each.at < 0.9)
    const levered = this.minds || (this.over ? this.at < QUEUED : lifting < LIFTS)
    if (!levered) this.eyed = null
    else this.eyed ??= clock
    let focus: Point
    let dip = 0
    if (this.stopped) {
      if (stop < 0.4) focus = above
      else if (stop < 1) focus = [RACK[0] + 0.6, RACK[1] - 0.65, this.tall + 1]
      else if (stop < 1.9) {
        focus = face(stop < 1.45 ? this.tall - 0.4 : 0.4)
        dip = 0.14 * Math.sin((((stop - 1) / 0.45) % 1) * Math.PI)
      } else if (stop < READS + 0.45) focus = SLAPS
      else focus = face(this.tall / 2)
    } else if (levered) focus = [LEVER[0], LEVER[1], 1.1]
    else if (swap < 0.9) focus = above
    else if (tray >= 0) focus = face((tray + 0.5) * UNIT)
    else if (clock - this.raised < 0.8) focus = face(this.tall)
    else if (clock - this.disk.at < 1) focus = [CHEST[0], CHEST[1] - 0.45, 0.6]
    else if (core >= 0) focus = FURNACES[core] as Point
    else if (this.at < QUEUED || this.at >= LOADING) focus = above
    else if (this.at <= ALLOCATING) focus = face(0.2)
    else if (this.at === STORAGE) focus = [CHEST[0], CHEST[1] - 0.45, 0.6]
    else if (this.at === COMPUTE) focus = face(UNIT / 2)
    else if (this.at === BOOTING) focus = face((Math.min(trays - 1, Math.floor(since / 0.3)) + 0.5) * UNIT)
    else focus = face(this.tall * 0.6)
    // Once the world is riding he nods up at it, once and slowly.
    const nodding = clock - this.rose - 0.8
    if (riding && nodding > 0 && nodding < 1.1) dip = 0.2 * Math.sin((nodding / 1.1) * Math.PI)
    const du = focus[0] - WORKER[0]
    const dv = focus[1] - WORKER[1]
    const gaze = clamp(Math.atan2(-dv, du), -0.9, 0.9)
    const nod = clamp(-Math.atan2(focus[2] - EYES, Math.hypot(du, dv)), -0.55, 0.45) + dip
    const turned = settled ? 1 : 1 - Math.exp(-dt * 7)
    this.gaze += (gaze - this.gaze) * turned
    this.nod += (nod - this.nod) * turned
    const head = { gaze: this.gaze * view.handed, nod: this.nod }
    worker(view, hand, Math.abs(hand.arm) > 0.02 ? { tool: hand.arm, ...head } : head)
  }

  /** Something heavy has landed at a place in the room: a couple of chips fly from its foot. */
  private landed(view: View, at: Point): void {
    const [x, y, z] = view.at(at[0], at[1], at[2])
    view.chips([x - 0.5, y, z - 0.5], [0, 0.5, 0], 2, 0.25)
  }

  /** Every part straight into its state for what is said, with nothing played. */
  private settle(view: View, told: Told): void {
    const { clock } = view
    this.kind = told.modded
    this.trays = told.trays
    this.fires = told.cores
    this.stopped = told.fault
    this.at = told.i
    this.over = told.i >= QUEUED && !told.fault
    // A start that stopped had a whole machine to stop.
    this.framed = told.fault || told.i >= ALLOCATING
    this.chested = told.fault || told.i >= STORAGE
    this.fitted = told.fault || told.i >= COMPUTE
    // Held still, every lamp that is on is lit: a lamp caught between blinks would read as broken.
    const lit = told.i >= BOOTING && !told.fault
    this.rack.settle(
      this.fitted ? told.trays : 0,
      !lit ? 'off' : view.still || told.i === BOOTING ? 'booting' : 'on',
      this.framed ? told.trays : 0,
    )
    this.cores.forEach((core, n) => {
      core.on = this.fitted && n < told.cores
      core.at = SETTLED
    })
    this.disk.on = this.chested
    this.disk.at = SETTLED
    this.threw = SETTLED
    this.lifted = SETTLED
    this.faulted = SETTLED
    this.stepped = SETTLED
    this.caught = SETTLED
    this.clapped = SETTLED
    this.lidded = SETTLED
    this.switched = SETTLED
    this.busy = told.i >= STARTING && !told.fault ? clock : SETTLED
    this.quiet = SETTLED
    this.posted = told.fault ? clock - 10 : SETTLED
    this.torn = SETTLED
    this.swapped = SETTLED
    this.raised = SETTLED
    this.rose = SETTLED
    this.sinks = false
    this.minds = false
    // The one held moment with nothing said is the build: the lowest tray proud of its bay.
    const lowest = this.rack.slots[0]
    if (view.still && !view.showing && lowest) {
      lowest.on = true
      lowest.at = clock - 0.36
    }
  }

  /** Takes the room one beat toward what is said. */
  private follow(told: Told, clock: number): void {
    const from = this.at
    const reached = (step: number) => this.at >= step && !this.stopped
    const ran = [COMPUTE, STARTING, LOADING, ONLINE].map(reached)
    // A different world gets a different machine: until this one is down and the world on the
    // plate is the one asked for, nothing is started.
    const other = told.modded !== this.kind
    const wanted = other ? IDLE : told.i
    if (!other) {
      this.trays = told.trays
      this.fires = told.cores
    }
    const swap = clock - this.swapped
    // Head first, then hand: he moves the lever only once his head has been on it for a beat.
    const looked = this.eyed !== null && clock - this.eyed >= LOOKS
    this.minds = false

    if (told.fault && !other) {
      if (!this.stopped) {
        // A stop. The lever springs back by itself; the rack is read, and then written up.
        this.stopped = true
        this.at = told.i
        this.over = false
        this.faulted = clock
        this.posted = clock + READS
        this.world.bob += 1.6
      }
    } else {
      if (this.stopped) {
        // Whatever comes after a stop starts from the lever, which is off.
        this.stopped = false
        this.at = IDLE
        if (clock < this.posted) this.posted = SETTLED
      }
      const down = !this.over && clock - this.lifted >= LIFTS
      if (this.over && wanted < this.at) {
        // An answer changed, or a new start was asked for with the lever still over: he looks
        // down at it, and lifts it.
        this.minds = true
        if (looked) {
          this.over = false
          this.lifted = clock
        }
      } else if (!this.over && this.at >= QUEUED && clock - this.lifted >= REACHES) {
        // As it leaves its seat the server goes dark.
        this.at = IDLE
      } else if (other && down) {
        // Taken down the way it went up: trays and furnaces, then the chest, each bay sinking
        // after its tray. Then the world on the bare plate is swapped.
        this.framed = false
        this.fitted = false
        if (this.rack.trays === 0 && this.cores.every((core) => !core.on)) this.chested = false
        const cleared = [...this.cores, this.disk].every((part) => !part.on && clock - part.at > 0.5)
        if (this.tall < 0.01 && cleared && swap > 2) {
          this.swapped = clock
          this.world.whirl += 9
          this.world.bob += 2
        }
        if (swap >= GOES && swap < 2) this.kind = told.modded
      } else if (!this.over && wanted >= QUEUED && down && swap >= SWAPS) {
        // A start: he looks down at the lever, and with his hand on the handle throws it. A
        // notice comes off as it lands.
        this.minds = true
        if (looked && Math.abs(this.hand.arm - HOLDS) < 0.2) {
          this.over = true
          this.threw = clock
          if (this.posted !== SETTLED && this.torn < this.posted) this.torn = clock + THROWS
        }
      } else if (this.over && this.at < QUEUED) {
        if (clock - this.threw >= THROWS) {
          this.at = QUEUED
          this.stepped = clock
        }
      } else if (
        this.over &&
        this.at < wanted &&
        clock - this.stepped >= (this.at === QUEUED ? 0.4 : APACE)
      ) {
        // On, a step at a time. A machine that stands is not built twice: once the word has
        // reached it, its start is taken up at the step that is said.
        // Plain Minecraft has no jars to check, and no step for it.
        const next = this.at + (this.at + 1 === VERIFYING && !this.kind ? 2 : 1)
        this.at = this.at === QUEUED && this.fitted ? wanted : next
        this.stepped = clock
      }
    }

    // What the step that was just reached does. Each part is made at its own step, unless it
    // stands already.
    if (this.at === STORAGE && from < STORAGE && this.chested) this.clapped = clock
    if (this.at >= ALLOCATING) this.framed = true
    if (this.at >= STORAGE) this.chested = true
    if (this.at >= COMPUTE) this.fitted = true
    if (this.disk.on !== this.chested) {
      this.disk.on = this.chested
      this.disk.at = clock
    }
    const runs = [COMPUTE, STARTING, LOADING, ONLINE].map(reached)
    if (runs[0] && !ran[0]) this.caught = clock
    if (runs[1] && !ran[1]) this.busy = clock
    if (!runs[1] && ran[1]) this.quiet = clock
    if (runs[2] !== ran[2]) {
      this.lidded = clock
      if (runs[2]) this.world.whirl += 8
    }
    if (runs[3] && !ran[3]) {
      this.rose = clock
      this.sinks = false
    }
    if (!runs[3] && ran[3]) this.sinks = true
  }

  /** What the demonstration says, or, alone, the same values on a clock of its own. */
  private told(view: View): Told {
    const said = view.showing
    if (said) {
      const gb = Number(said.gb)
      return {
        trays: gb >= 8 ? 5 : gb >= 4 ? 4 : 3,
        cores: clamp(Number(said.cores) || 1, 1, 4),
        modded: said.modded === true,
        i: (STEPS as readonly string[]).indexOf(String(said.step)),
        fault: said.fault === true,
      }
    }
    const plain = { trays: 3, cores: 1, modded: false, fault: false }
    // One held moment: the build, with the frame up and the chest down.
    if (view.still) return { ...plain, i: STORAGE }
    // A round at the demonstration's own pace, in which every start builds: three trays for the
    // tree world, taken down; four for the cog world, a start that hangs and stops, and a second
    // go on the machine that stands; taken down.
    this.own += view.dt
    const t = this.own % ROUND
    const pack = { trays: 4, cores: 2, modded: true, fault: false }
    if (t < 6.8) return { ...plain, i: [0, 1, 2, 3, 4, 5, 6, 8][Math.floor(t / 0.85)] ?? ONLINE }
    if (t < 11) return { ...plain, i: ONLINE }
    if (t < 14) return { ...pack, i: IDLE }
    if (t < 19.1) return { ...pack, i: Math.min(STARTING, Math.floor((t - 14) / 0.85)) }
    if (t < 21.7) return { ...pack, i: LOADING }
    if (t < 25.3) return { ...pack, i: LOADING, fault: true }
    if (t < 28.7) return { ...pack, i: [BOOTING, STARTING, LOADING, 8][Math.floor((t - 25.3) / 0.85)] ?? 8 }
    if (t < 33) return { ...pack, i: ONLINE }
    return { ...plain, i: IDLE }
  }
}

/**
 * Kit candidate: paper knocked off its board. The kit's `slip`, taken off, slides straight down
 * its pole and ends standing half sunk in whatever is at the foot of it. This one is sprung clear
 * in one arc, from `from` on the board to `to` on the floor, tipping flat as it goes; it lies
 * there a moment and pops away. `off` is seconds since it came off.
 */
function shed(view: View, from: Point, to: Point, wide: number, tall: number, off: number): void {
  const through = clamp(off / 0.45)
  const size = 1 - windup(clamp((off - 0.55) / 0.2))
  if (size < 0.02) return
  const [u, v, h] = flight(from, to, through, 0.8)
  const part = partsAt(view.box, view.place(u, v, h))
  part(0, 0.02, 0, wide * size, tall * size, 0.03, 250, Kind.wool, 0, (through * Math.PI) / 2)
}

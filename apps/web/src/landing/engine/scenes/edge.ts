/**
 * The address: one door, the server behind it, and the doorkeeper.
 *
 * A knock at the door wakes the server, and the door is opened. The rack stands dark at the back
 * with its chest shut beside it, latch lit and breathing: the world is in there, asleep. A friend
 * walks up the lane and raps twice on the shut door. The knock runs the wire to the foot of the
 * rack, the lamps come on tray by tray, the lid is thrown open and the world springs out to ride
 * over the rack. The word runs back along the wire to the door, and the doorkeeper, whose hand
 * has gone out to the leaf, throws it open. The friend walks through, and is in the game.
 *
 * The doorkeeper is the edge. He stands just inside the door and never leaves it. He does not
 * wake the server: the knock does, by the wire, and nobody throws a switch. His hands touch only
 * the door: he opens it when the server is up and swings it shut when it goes down, and his head
 * goes to whatever has just happened before his hand moves.
 *
 * Two shorter turns of the same story. While the server restarts a knock is answered by the sign
 * beside the door: its lamp blinks, the doorkeeper turns to look at it, the friend reads it,
 * turns round and leaves. And a refresh of the list is nobody at all: a pulse comes in along the
 * floor to the door and goes on to whichever end answers, which wakes nothing.
 *
 * It follows the section's demonstration, which says: `power` ('stopped', 'starting', 'running'
 * or 'restarting'), `route` ('server' or 'notice'), `joining`, `held` (the join is being held at
 * the door) and `asking` (the list has asked and not heard back). Where every part should be
 * follows from those, so the scene can be joined at any moment; only changes are acted out, each
 * waiting for its cause: the pulse for the knock, the lamps for the pulse, the door for the lamps.
 * Left alone it gives itself the same values on a clock.
 */
import { LIT } from '../chunk'
import { clamp, ease, lerp, wrap } from '../curves'
import { type Box, figure, KAI, MOSS, NOOR, type Skin, veiled } from '../models'
import { between, type Point, PULSE, type RoomScene, runIn, type View, wireIn, worker } from '../rooms'
import {
  chest,
  door,
  drop,
  given,
  HITS,
  lid,
  notice,
  overshoot,
  type Place,
  partsAt,
  puff,
  Rack,
  Rider,
  SETTLED,
  SHUTS,
  smallWorld,
  thrown,
  UNIT,
  windup,
} from '../server'
import { type Body, bodyAt, EASE, FOOTFALL, headingOf, reach, type Spot, STROLL, turn, walk } from '../walk'
import { Kind } from '../world'

/**
 * Where things stand, in the room's terms. The camera looks in from the front and a little from
 * the far end, so the tall rack is at the back on the near end with its chest beside it, the door
 * stands in the middle further along, and nothing is in front of the door's line but the friend.
 * The door's leaf is hinged on the rack's side: shut, its free edge is at the doorkeeper's hand.
 */
const RACK: Spot = [2.6, 2.1]
const CHEST: Spot = [4.25, 2.1]
const DOOR: Spot = [7, 3.6]
const KEEPER: Spot = [8.3, 3]
const SIGN: Spot = [9.8, 3.5]
/** The leaf's hinge, at the foot of the post on the rack's side. */
const HINGE: Spot = [6.5, 3.5]
/**
 * Which way the doorkeeper looks, as headings in the room: along his body to the door he faces,
 * at the doorway, past it to the rack, and round behind him to the sign. The sign is further
 * round than a neck goes, so his body comes part of the way after his head.
 */
const FACING = headingOf([-1, 0])
const DOORWAY = headingOf([DOOR[0] - KEEPER[0], DOOR[1] - KEEPER[1]])
const RACKWARD = FACING - 0.3
const SIGNWARD = headingOf([SIGN[0] - KEEPER[0], SIGN[1] - KEEPER[1]])
const TURNED = SIGNWARD - 0.3
const NECK = 1.25
/** The friend's lane: in at the open wall, up to the door, and through it. */
const ENTRY: Spot = [7, 6.6]
const KNOCK: Spot = [7, 4.4]
const PAST: Spot = [7, 2.2]
const OUT: Spot = [7, 7]
/** Past the door a player is in the game: they thin from here, and are gone by here. */
const THINS = 3.8
const GONE = 2.6
/**
 * The redstone. In from the open wall to the foot of the door's post on the sign's side; from the
 * other post to the foot of the rack; and from the door to the sign. The frame carries a pulse
 * over the doorway, so no wire crosses the friend's lane.
 */
const WIRE_IN: readonly Spot[] = [
  [7.9, 7],
  [7.9, 3.7],
]
const WIRE_UP: readonly Spot[] = [
  [6.1, 3.5],
  [2.6, 3.5],
  [2.6, 2.1],
]
const WIRE_BACK: readonly Spot[] = [...WIRE_UP].reverse()
const WIRE_SIGN: readonly Spot[] = [
  [7.9, 3.5],
  [9.6, 3.5],
]
/** How long a pulse is on each: they all run at the one speed. */
const IN_TAKES = 3.3 / PULSE
const UP_TAKES = 4.9 / PULSE
const SIGN_TAKES = 1.7 / PULSE

/**
 * The world: riding over the rack, in the mouth of its open chest, and tucked down inside it. The
 * chest is a solid box and the world is drawn through anything it pokes out of, so in the chest
 * it stands square to the walls, on the chest's floor or above it, and under where the lid shuts.
 */
const OVER: Point = [2.6, 1.15, 3]
const MOUTH: Point = [4.25, 1.75, 0.15]
const INSIDE: Point = [4.25, 1.75, 0]
/** How big it is in the chest's mouth, and tucked under the lid: its tree has to fit. */
const SNUG = 0.72
const TUCKED = 0.68
/** Out: the lid is thrown a moment before it leaves, and it is in the air this long. */
const LEAVES = 0.06
const FLIES = 0.45
const RISES = LEAVES + FLIES
/**
 * How far through the kit's `overshoot` its top is, a tenth past where it is going. The world's
 * rise ends there, at the top of its jump, and its spring takes it from there.
 */
const CREST = 0.58
/**
 * Back: this long in the air, and then the kit's two bounces (`drop` falls for FALL before its
 * first). The second bounce knocks the lid shut over it.
 */
const DROPS = 0.45
const FALL = 0.36
const BOUNCE = 0.26
const AGAIN = 0.15
const FALLS = DROPS + BOUNCE + AGAIN
/** How long the kit's rack takes to light three trays from the bottom, and to put them out from the top. */
const SWEEP = 0.87
const DIMS = 0.62

/** The friend's two raps: when each lands, from when they stopped at the door. */
const RAPS: readonly [number, number] = [0.5, 0.95]
const HAND_OUT = -1.35
/** How long a door goes on moving after it is thrown, or rattles in its frame after it is shut. */
const SETTLES = 0.6
const RATTLES = 0.25
/** The doorkeeper's arm: a hand on the edge of the shut leaf, and reached right out for the open one. */
const ON_EDGE = -0.95
const REACHED = -1.5

const FRIENDS: readonly Skin[] = [MOSS, KAI, NOOR]
const ROUND = 30
/** A time that never comes. */
const NEVER = Number.POSITIVE_INFINITY

type Power = 'stopped' | 'starting' | 'running' | 'restarting'

interface Told {
  power: Power
  route: 'server' | 'notice'
  joining: boolean
  held: boolean
  asking: boolean
}

interface Friend extends Body {
  who: number
  /**
   * On the way to the door, knocking at it, waiting at it, reading the sign, going through, or
   * leaving: easing to a stop first, if they were turned back on the way.
   */
  state: 'in' | 'knocking' | 'waiting' | 'reading' | 'through' | 'stopping' | 'away'
  /** When that began. */
  since: number
  /** How much of them is there: people thin in and out at the room's edge. */
  there: number
  /** The sign is their answer: they are turned away once their knock has landed. */
  turned: boolean
  /** How far their head is turned. */
  gaze: number
}

export class EdgeScene implements RoomScene {
  private readonly rack = new Rack(3, 3, 'off')
  private readonly world = new Rider()
  private readonly keeper = bodyAt(KEEPER, [-1, 0])
  private friend: Friend | null = null
  private joins = 0
  private was: Told | null = null
  /** The world is out of its chest or on its way out, and when it last set off either way. */
  private out = false
  private moved = SETTLED
  /** When the lamps last began to come on, and to go out. */
  private booted = SETTLED
  private dimmed = SETTLED
  /** A restart is under way: dark, a beat, and one sweep. */
  private again = false
  /** The chest's breath: when its first puff rises, and when it stopped. */
  private slept = SETTLED
  private woken = NEVER
  /** The door: whether it is open, when it was last thrown or swung, and when a rap last landed on it. */
  private open = false
  private swung = SETTLED
  private rapped = SETTLED
  /** When the doorkeeper saw that it had to be shut. */
  private minded = SETTLED
  /** The knock on its way to the rack, and the word on its way back: whether, and since when. */
  private waking = false
  private woke = SETTLED
  private calling = false
  private word = SETTLED
  /**
   * A refresh: whether one is waiting on the door, when it came in at the open wall, and when it
   * left the door for the rack or the sign.
   */
  private asks = false
  private asked = SETTLED
  private pinged = SETTLED
  private noted = SETTLED
  /**
   * The doorkeeper's head: what happened last, the door or the rack; whether the sign has just
   * answered instead, and when he last looked to it or away; whether his head is up; and where
   * it has got to.
   */
  private focus: 'door' | 'rack' = 'door'
  private signed = false
  private looked = SETTLED
  private alert = false
  private gaze = 0
  private nod = 0
  /** The round it plays alone opens on the knock: the friend's hand out to the shut door. */
  private own = 2.2

  step(view: View): void {
    const { clock, dt, box } = view
    const told = this.told(view)
    const first = this.was === null
    const was = this.was ?? told
    this.was = told
    const up = told.power !== 'stopped'
    const keeper = this.keeper
    /** True on the frame the clock passes a moment. */
    const just = (when: number) => clock >= when && clock - dt < when

    // Only changes are acted out; joined part-way, or held still, every part is simply as it
    // should be.
    if (first || view.still) {
      const knocking = told.route === 'notice' && (view.still || told.joining)
      // Joined as the knock is about to wake it, the server is still dark: the knock comes first.
      const dark = !up || (told.power === 'starting' && knocking && !view.still)
      this.rack.settle(3, dark ? 'off' : told.power === 'running' ? 'on' : 'booting')
      this.out = told.power === 'running'
      this.moved = SETTLED
      this.booted = SETTLED
      this.dimmed = SETTLED
      this.again = false
      // Held still, three puffs hang over the lid.
      this.slept = view.still ? clock - 2.94 : SETTLED
      this.woken = dark ? NEVER : SETTLED
      this.open = told.route === 'server'
      this.swung = SETTLED
      this.rapped = SETTLED
      this.minded = SETTLED
      this.waking = false
      this.woke = SETTLED
      this.calling = false
      this.word = SETTLED
      this.asks = false
      this.asked = SETTLED
      this.pinged = SETTLED
      this.noted = SETTLED
      this.focus = 'door'
      this.signed = false
      this.looked = SETTLED
      this.alert = view.still || !dark
      keeper.arm = 0
      keeper.heading = FACING
      keeper.spin = 0
      this.friend = knocking
        ? {
            ...bodyAt(KNOCK, [0, -1]),
            arm: HAND_OUT,
            who: this.joins,
            state: 'knocking',
            since: clock - 0.2,
            there: 1,
            turned: false,
            gaze: 0,
          }
        : null
    } else {
      const lamps = this.rack.power
      const lit = lamps !== 'off' && clock - this.booted >= SWEEP
      const dark = clock - this.dimmed

      // A join is a friend at the open wall. One at a time: with the last still in the room, the
      // next is not shown.
      if (told.joining && !was.joining && !this.friend) {
        this.joins += 1
        this.friend = {
          ...bodyAt(ENTRY, [0, -1]),
          who: this.joins,
          state: 'in',
          since: clock,
          there: 0,
          turned: false,
          gaze: 0,
        }
      }
      if (was.held && !told.held && told.joining && told.route === 'notice' && this.friend)
        this.friend.turned = true

      // A refresh is a pulse in from the open wall to the door. Held there, the edge has answered
      // by itself; otherwise it goes on to whichever end the name leads to. It is asked of the
      // door as it stands: while the door is on its way open or shut the pulse does not set out,
      // so the sign's lamp has come on with the slam before anything makes it blink.
      if (told.asking && !was.asking) this.asks = true
      const stood = clock - this.swung
      const stands =
        told.route === 'server' ? this.open && stood >= SETTLES : !this.open && stood >= SHUTS + RATTLES
      if (this.asks && (told.held || stands)) {
        this.asks = false
        this.asked = clock
        if (!told.held && told.route === 'server') this.pinged = clock + IN_TAKES
        if (!told.held && told.route === 'notice') this.noted = clock + IN_TAKES
      }

      // Save, then stop: the world goes back into its chest before a lamp goes out.
      if (this.out && told.power !== 'running' && clock - this.moved >= RISES + 0.7) {
        this.out = false
        this.moved = clock
      }
      const put = !this.out && clock - this.moved >= FALLS
      // A restart is the lamps out, a dark beat, and one sweep. Once, not over and over.
      if (!up) this.again = false
      else if (told.power !== 'running' && lamps === 'on') this.again = true
      if (lamps !== 'off' && lit && put && (!up || this.again)) {
        this.rack.set('off', clock)
        this.dimmed = clock
        // Asleep, its chest begins to breathe a little after the last lamp.
        this.slept = clock + DIMS + 1.2
        this.woken = NEVER
        // The lamps going out are what has just happened.
        this.focus = 'rack'
      } else if (lamps === 'off' && up) {
        const friend = this.friend
        // With a friend on the way to the door, the knock comes first: it is what wakes it.
        const knocking =
          friend?.state === 'in' || (friend?.state === 'knocking' && clock < friend.since + RAPS[1])
        let boots = false
        if (this.again) boots = dark >= DIMS + 0.8
        else if (told.power === 'restarting') boots = dark >= DIMS
        else if (this.waking) boots = clock - this.woke >= UP_TAKES
        else if (dark >= DIMS && !knocking) {
          // The knock goes down the wire, and the doorkeeper's head after it.
          this.waking = true
          this.woke = clock
          this.focus = 'rack'
          this.alert = true
        }
        if (boots) {
          this.rack.set('booting', clock)
          this.booted = clock
          this.woken = clock
          this.again = false
          this.waking = false
          // Lamps coming on behind the door lift his head to them, whatever started them.
          this.focus = 'rack'
          this.alert = true
        }
      }
      if (!up) this.waking = false
      // Running: its lamps go from held to blinking, the lid is thrown and the world springs out.
      if (told.power === 'running' && lit) {
        if (lamps === 'booting') this.rack.set('on', clock)
        if (put) {
          this.out = true
          this.moved = clock
        }
      }

      // The door never opens onto a dark server: the word comes back along the wire only when
      // every lamp is on and the world is up, and the door is thrown as it lands.
      if (told.route === 'server' && !this.open) {
        const ready = lit && (this.out ? clock - this.moved >= RISES : told.power !== 'running')
        if (this.calling) {
          if (clock - this.word >= UP_TAKES) {
            this.calling = false
            this.open = true
            this.swung = clock
          }
        } else if (ready) {
          this.calling = true
          this.word = clock
          this.focus = 'door'
          this.alert = true
        }
      } else this.calling = false
      // Shut when the name leads to the notice again: once he has seen that it must be, his arm
      // goes right out toward the leaf at its stop, and it is hauled in from there. With someone
      // in the doorway he waits for them.
      if (told.route === 'notice' && this.open) {
        if (this.minded <= this.swung) this.minded = clock
        const clear = this.friend?.state !== 'through' && clock - this.swung >= SETTLES
        if (keeper.arm <= REACHED + 0.1 && clear) {
          this.open = false
          this.swung = clock
        }
      }
    }
    const swing = clock - this.swung
    const trip = clock - this.moved

    // The server: read by its lamps and nothing else. Asked how it is while it runs, its trays'
    // lamps wink in turn, once.
    const stands = view.place(RACK[0], RACK[1])
    const top = this.rack.draw(box, stands, clock)
    wink(box, stands, clock - this.pinged - UP_TAKES)
    // Warm light on the floor in front of it, a third for each tray that is lit.
    const trays =
      this.rack.power === 'off'
        ? clamp(Math.ceil((DIMS - (clock - this.dimmed)) / 0.22), 0, 3)
        : clamp(Math.floor((clock - this.booted) / 0.3) + 1, 0, 3)
    view.light(RACK[0], 3, 0.6, 4.5, (0.8 * trays) / 3)

    // Its chest. Shut with the latch lit, the world is in it. The lid is thrown open by the world
    // leaving, jumps as it lands again, and is knocked shut by its second bounce.
    const landing = drop(FALL + trip - DROPS, 1.9)
    const open = this.out
      ? lid(true, trip)
      : trip < DROPS
        ? 1
        : trip < DROPS + BOUNCE
          ? 1 - 0.3 * landing.jolt
          : lid(false, trip - DROPS - BOUNCE)
    const kept = view.place(CHEST[0], CHEST[1])
    chest(box, kept, open, !this.out && trip >= FALLS)
    breathing(box, kept, clock, this.slept, this.woken)

    // The world. Out, it rides over the rack on its spring, turning. It gets there in one move:
    // sprung up beside the rack and across over its top, a third of a block too high, and the
    // spring brings it back. Going in, it comes back across with a hop, drops and bounces, and
    // the lid comes down on it. Either way it goes round the rack's corner, never through it.
    const rest = top + 0.6
    const tall = OVER[2] - INSIDE[2]
    if (first || view.still) this.world.settle(rest)
    // It is spun up as it clears the chest, not before: inside, it has no room to turn.
    if (this.out && just(this.moved + LEAVES)) this.world.whirl = 8
    if (this.out && just(this.moved + RISES)) {
      this.world.settle(rest)
      this.world.ride = rest + tall * (overshoot(CREST) - 1)
    }
    this.world.step(dt, rest, top + 0.1, this.out ? 0.4 : 0)
    if (!this.out) {
      // Its turning slows to a stop square to the chest it is going into.
      const quarter = Math.PI / 2
      const square = view.facing(0) + Math.round((this.world.spin - view.facing(0)) / quarter) * quarter
      this.world.spin += (square - this.world.spin) * (1 - Math.exp(-dt * 10))
    }
    const draw = (at: Point, scale: number) => {
      const [x, y, z] = view.at(at[0], at[1], at[2])
      smallWorld(box, { x, y, z, heading: this.world.spin, inside: view.inside, scale }, 'survival', clock)
    }
    if (this.out) {
      // Not drawn until the lid is out of its way: shut in the chest there is nothing to see.
      const flown = clamp((trip - LEAVES) / FLIES)
      if (trip >= RISES) draw([OVER[0], OVER[1], OVER[2] + this.world.ride - rest], 1)
      else if (trip >= LEAVES)
        draw(
          between(INSIDE, OVER, ease(clamp((flown - 0.3) / 0.7)), overshoot(CREST * flown)),
          lerp(TUCKED, 1, flown),
        )
    } else if (trip < DROPS) {
      const gone = trip / DROPS
      draw(between(OVER, MOUTH, ease(clamp(gone / 0.7)), windup(gone)), lerp(1, SNUG, gone))
    } else if (trip < DROPS + BOUNCE) {
      draw([MOUTH[0], MOUTH[1], MOUTH[2] + landing.up], SNUG)
    } else if (trip < FALLS) {
      // Knocked down under the lid as it falls: onto the chest's floor, and no lower.
      const down = ((trip - DROPS - BOUNCE) / AGAIN) ** 2
      draw(between(MOUTH, INSIDE, 0, down), lerp(SNUG, TUCKED, down))
    }

    // The door: thrown open against its stop, swung shut against its frame, and pushed in a few
    // degrees by each rap. The lamp over it is lit while it is open.
    const ajar = this.open ? thrown(swing) : 1 - clamp(swing / SHUTS) ** 2
    const through = this.open ? swing >= HITS : swing < SHUTS
    door(
      box,
      view.place(DOOR[0], DOOR[1]),
      ajar,
      through,
      given(clock - this.rapped) + (this.open ? 0 : 0.4 * given(swing - SHUTS)),
    )

    // The sign beside it, with a lamp on top that is lit while the door is shut: this is what
    // answers. Whatever reaches it makes the lamp blink twice: out, and on again.
    const blink = clock - this.noted - SIGN_TAKES
    const blinks = blink >= 0 && blink < 0.6 && Math.floor(blink / 0.15) % 2 === 0
    const answers = !through && !blinks
    const sign = view.place(SIGN[0], SIGN[1], 0, 0, 0.75)
    notice(box, sign)
    partsAt(box, sign)(
      0,
      1.92,
      0,
      0.53,
      0.53,
      0.53,
      answers ? 80 : 60,
      answers ? Kind.lamp : Kind.dark,
      answers ? LIT : 0,
    )

    // The redstone, and what is on its way along it.
    wireIn(view, WIRE_IN)
    wireIn(view, WIRE_UP)
    wireIn(view, WIRE_SIGN)
    runIn(view, WIRE_IN, clock - this.asked)
    runIn(view, WIRE_UP, clock - this.woke)
    runIn(view, WIRE_UP, clock - this.pinged)
    runIn(view, WIRE_BACK, clock - this.word)
    runIn(view, WIRE_SIGN, clock - this.noted)

    // The friend. To the door, and straight through it if it is open; at a shut door they rap
    // twice and wait, hand down, looking at it. Answered by the sign, they read it, turn round
    // and walk out the way they came.
    const friend = this.friend
    if (friend && !view.still) {
      const age = clock - friend.since
      let arm = 0
      let rate = 6
      let look = 0
      if (friend.state === 'in') {
        friend.there = clamp(friend.there + dt / 0.4)
        // An open door is walked straight through, without a stop at it.
        if (this.open) friend.state = 'through'
        else if (!told.joining) friend.state = 'stopping'
      }
      if (friend.state === 'in') {
        if (walk(friend, KNOCK, STROLL, dt)) {
          friend.state = 'knocking'
          friend.since = clock
        }
      } else if (friend.state === 'knocking') {
        // A hand out to the leaf: drawn back before each rap, and brought down on it.
        const drawn = RAPS.some((rap) => age >= rap - 0.17 && age < rap - 0.05)
        const struck = RAPS.some((rap) => age >= rap - 0.05 && age < rap + 0.05)
        arm = drawn ? -0.7 : struck ? -1.5 : HAND_OUT
        rate = drawn || struck ? 10 : 6
        for (const rap of RAPS)
          if (just(friend.since + rap)) {
            this.rapped = clock
            // At the first rap the doorkeeper's head lifts to the door.
            this.alert = true
            if (!this.waking) this.focus = 'door'
          }
        if (age >= RAPS[1] + 0.25) friend.state = 'waiting'
      } else if (friend.state === 'waiting') {
        if (friend.turned) {
          // Turned away: a pulse from the door to the sign, and both heads after it.
          this.noted = clock
          this.signed = true
          this.looked = clock
          friend.state = 'reading'
          friend.since = clock + SIGN_TAKES
        } else if (this.open) {
          if (swing >= 0.45) friend.state = 'through'
        } else if (!told.joining && told.route === 'notice') friend.state = 'away'
      } else if (friend.state === 'reading') {
        if (age >= 0) look = -1.2
        if (age >= 1.3) friend.state = 'away'
      } else if (friend.state === 'stopping') {
        if (halt(friend, STROLL, dt)) friend.state = 'away'
      } else if (friend.state === 'away') {
        walk(friend, OUT, STROLL, dt)
        friend.there = Math.min(friend.there, clamp((ENTRY[1] - friend.z) / 0.8))
        if (friend.z >= ENTRY[1]) this.friend = null
      } else {
        walk(friend, PAST, STROLL, dt)
        friend.there = Math.min(friend.there, clamp((friend.z - GONE) / (THINS - GONE)))
        if (friend.z <= GONE) this.friend = null
      }
      reach(friend, arm, dt, rate)
      friend.gaze += (look * view.handed - friend.gaze) * (1 - Math.exp(-dt * 9))
    }
    if (this.friend) {
      const here = this.friend
      const read = clock - here.since - 0.45
      // They read the sign with one nod.
      const nod =
        here.state === 'reading' && read > 0 && read < 0.5 ? 0.3 * Math.sin((read / 0.5) * Math.PI) : 0
      const head = { gaze: here.gaze, nod }
      figure(
        veiled(box, ease(here.there)),
        view.stance(here, STROLL, view.still ? undefined : clock + here.who),
        FRIENDS[here.who % FRIENDS.length] ?? MOSS,
        // The hand that knocks is the one on the camera's side of them.
        Math.abs(here.arm) < 0.02
          ? head
          : view.handed > 0
            ? { ...head, other: here.arm }
            : { ...head, tool: here.arm },
      )
    }

    // The doorkeeper: just inside the door, facing it, and never anywhere else. His head goes to
    // what has just happened: up to the door at a knock, after the pulse to the rack, back with
    // the word to the door, to lamps going out or coming on behind it, to the sign when it
    // answers. His hand goes out to the leaf while the word is on its way and throws it as the
    // word lands; it reaches for the open leaf when the server goes, and comes in with it.
    if (this.signed && (!this.friend || this.calling)) {
      // The friend the sign answered has gone, or the door is wanted: back to the door.
      this.signed = false
      this.looked = clock
      this.focus = 'door'
    }
    // Asleep: once the chest breathes there is nothing left to watch, and with nobody knocking
    // his head goes down.
    if (!up && this.rack.power === 'off' && !this.open && clock >= this.slept && !view.still) {
      this.focus = 'door'
      if (!this.friend || this.friend.state === 'in') this.alert = false
    }
    // The sign is behind him: his head goes first, as far round as it will, and his body follows
    // it part of the way, on the spot. Back to the door the same.
    const round = clock - this.looked >= 0.12 === this.signed
    keeper.want = round ? TURNED : FACING
    const faced = turn(keeper, dt) && !round
    // Shutting the door, he sees first that the server is going, and then has eyes only for the
    // leaf: out at its stop, in to the frame, and on it until it has stopped rattling.
    const shutting = this.open ? told.route === 'notice' : swing < SHUTS + RATTLES
    const waits = this.friend?.state === 'through'
    const seen = clock - this.minded >= 0.35
    const angle = ajar * (Math.PI / 2)
    const leaf = headingOf([HINGE[0] + Math.cos(angle) - KEEPER[0], HINGE[1] - Math.sin(angle) - KEEPER[1]])
    let want = 0
    let rate = 5
    if (this.calling) want = clock - this.word >= 0.25 ? ON_EDGE : 0
    else if (this.open && swing < 0.5) {
      want = REACHED
      rate = 14
    } else if (this.open && shutting && seen && !waits) want = REACHED
    else if (!this.open && shutting) {
      // His hand comes in with the leaf, and is on its edge as it hits the frame.
      want = ON_EDGE
      rate = 1.8
    }
    const arm = reach(keeper, faced ? want : 0, dt, rate)
    const look = this.signed
      ? SIGNWARD
      : shutting
        ? seen || told.power === 'running'
          ? leaf
          : RACKWARD
        : this.focus === 'rack'
          ? RACKWARD
          : DOORWAY
    // Looking at the rack he looks up at it, and further up at the world over it; at the sign,
    // down at its board; with nothing at his door and the server asleep, his head is a little down.
    const tipped = this.signed
      ? 0.2
      : shutting
        ? 0
        : this.focus === 'rack'
          ? this.out
            ? -0.25
            : -0.08
          : this.alert
            ? 0
            : 0.18
    const comes = first || view.still ? 1 : 1 - Math.exp(-dt * 8)
    this.gaze += (clamp(wrap(look - keeper.heading), -NECK, NECK) * view.handed - this.gaze) * comes
    this.nod += (tipped - this.nod) * comes
    const head = { gaze: this.gaze, nod: this.nod }
    worker(
      view,
      keeper,
      // The door is on the camera's side of him, and so is the hand he works it with.
      Math.abs(arm) < 0.02 ? head : view.handed > 0 ? { ...head, tool: arm } : { ...head, other: arm },
    )
  }

  /** What the demonstration says, or, alone, the same values on a clock of its own. */
  private told(view: View): Told {
    const said = view.showing
    if (said) {
      const power = String(said.power)
      return {
        power: power === 'starting' || power === 'running' || power === 'restarting' ? power : 'stopped',
        route: said.route === 'server' ? 'server' : 'notice',
        joining: said.joining === true,
        held: said.held === true,
        asking: said.asking === true,
      }
    }
    // One held moment: the knock.
    if (view.still) return { power: 'stopped', route: 'notice', joining: true, held: true, asking: false }
    // A round of thirty seconds: a friend wakes it and is let in, it restarts and the next
    // friend is turned away, and it sleeps. A refresh at each turn.
    this.own += view.dt
    const t = this.own % ROUND
    return {
      power:
        t < 2.1 ? 'stopped' : t < 4.9 ? 'starting' : t < 12 ? 'running' : t < 24 ? 'restarting' : 'stopped',
      route: t >= 6.3 && t < 12 ? 'server' : 'notice',
      joining: t < 9 || (t >= 17 && t < 21.1),
      held: (t >= 0.3 && t < 7.4) || (t >= 17.3 && t < 19.5),
      asking: (t >= 3 && t < 3.5) || (t >= 12 && t < 13.5) || (t >= 24 && t < 25.5),
    }
  }
}

/**
 * Kit candidate: a three-tray rack answering a question, `age` seconds after it was asked. Each
 * tray's four lamps swell in turn, bottom to top, once.
 */
function wink(box: Box, at: Place, age: number): void {
  const part = partsAt(box, at)
  for (let tray = 0; tray < 3; tray++) {
    const t = (age - tray * 0.14) / 0.22
    if (t <= 0 || t >= 1) continue
    const size = 0.15 + 0.1 * Math.sin(t * Math.PI)
    for (let lamp = 0; lamp < 4; lamp++)
      part(-0.815 + lamp * 0.25, tray * UNIT + 0.535, 0.235, size, size, 0.05, 80, Kind.lamp, LIT)
  }
}

/**
 * Kit candidate: the kit's breath with a beginning and an end. Its first puff rises alone at
 * `began` and the others follow in their turn; at `ended` no new puff sets out, and the ones in
 * the air swell a touch and are gone. `at` is where the chest stands.
 */
function breathing(box: Box, at: Place, clock: number, began: number, ended: number): void {
  const left = 1 - windup(clamp((clock - ended) / 0.25))
  if (clock < began || left < 0.02) return
  const part = partsAt(box, at)
  for (let n = 0; n < 3; n++) {
    const age = ((clock - began) / 3.6 + n / 3) % 1
    const born = clock - age * 3.6
    if (born < began - 0.001 || born > ended) continue
    const size = (0.12 + age * 0.2) * puff(age) * left
    if (size > 0.02)
      part(0.15 + age * 0.4, 0.95 + age * 1.3, -0.45 + n * 0.1, size, size, size, 250, Kind.wool)
  }
}

/**
 * Kit candidate: someone walking eases to a stop where they are, still facing the way they were
 * going. True once they stand.
 */
function halt(body: Body, cruise: number, dt: number): boolean {
  body.pace = Math.max(0, body.pace - (cruise / EASE) * dt)
  const move = body.pace * dt
  body.x += Math.sin(body.heading) * move
  body.z += Math.cos(body.heading) * move
  body.phase += (move / FOOTFALL) * Math.PI * 2
  return body.pace === 0
}

/**
 * Runtimes: a line, a switch, three doors, and the clerk who writes down where each server went.
 *
 * A new server is a small rack on a minecart, lamps dark, facing us. It rolls out of the dark by
 * itself, because somebody somewhere made one, gathers speed, and brakes at the switch in front
 * of the first door: its nose dips and it rocks back level. The two lamps beside that door are
 * the rules, read in order: each flickers three times and goes dark, not this one. Nothing takes
 * it, so it rolls on to the second door's turning, waits a beat, turns up the spur and bumps to a
 * stop in the doorway, where its lamps come on tray by tray exactly as they would at either of
 * the other doors. Nothing tells the doors apart, on purpose. Whatever stood there has rolled on
 * through the door into the dark as this one turned in.
 *
 * The same story ends three other ways. A rule takes it: the lamp that was flickering stays lit,
 * a pulse runs the floor wire to the points, they snap over with two sparks, and the cart turns
 * up the first spur. The default is full: the second door is shut and its lamp out, and the cart
 * rolls on to the end of the line and up to the third. Nowhere has room: it goes up to the shut
 * door and waits there, dark. A dozen at once is a train, 0.15 s apart, that stops for nothing:
 * carts for the same door follow each other through it, and the last for each door brakes in the
 * doorway and comes on.
 *
 * The worker is the clerk. He stands at the board and never leaves it; he sends nothing. His head
 * follows each cart to its door, and when it has stopped there he turns to the board and slaps a
 * slip on it: one for a server, one for a train.
 *
 * It follows the section's demonstration, which says: `at` (the rung the server on the ladder has
 * reached: 'arrive', 'allow', 'canary', 'default', or 'none'), `fleet`, `a` and `b` (how many
 * each runtime holds, followed only by how they change: one more is one server for that door,
 * any of them less is starting over) and `full` (the default runtime has no room). The room may
 * trail it, and never skips a beat or cuts one short: what a cart is told waits its turn. Only on
 * the first frame is anything put straight into place; after that every difference is made up
 * with the ordinary moves. Left alone it gives itself the same values on a clock.
 */
import { DARK, LIT } from '../chunk'
import { clamp, ease, lerp } from '../curves'
import type { Box } from '../models'
import { headTo, type Point, PULSE, type RoomScene, runIn, type View, wireIn, worker } from '../rooms'
import {
  board,
  CART_BED,
  door,
  given,
  HITS,
  overshoot,
  partsAt,
  RACK_DEEP,
  Rack,
  SETTLED,
  SHUTS,
  slap,
  slip,
  spark,
  thrown,
  cart as tub,
} from '../server'
import { bodyAt, headingOf, reach, type Spot } from '../walk'
import { Kind } from '../world'

const NEVER = Number.POSITIVE_INFINITY

/**
 * Where things stand, in the room's terms. The line runs side-on across the middle; the doors are
 * on the back wall at the low end of what the camera sees, in the order the policy reaches them:
 * the rules' runtime, the default, the overflow.
 */
const LINE = 3.5
const TUNNEL = 12.5
const DOORS: readonly number[] = [6.5, 4.5, 2.5]
const FRAME = 0.3
/** How far along the line a door's turning is, from the tunnel. */
const cornerOf = (door: number) => TUNNEL - (DOORS[door] as number)
const SWITCH = cornerOf(0)
const TURNING = cornerOf(1)
/** From the line up a spur to where a cart stands in a doorway, and where a second waits behind it. */
const UP = 2.1
const BEHIND = UP - 1.05
/** Through the door and down the hall, until the rock hides the last of it. */
const GONE = UP + 5.1
/** How far past the switch a cart's middle is off the points, and how far it is clear of them. */
const PAST = 0.3
const CLEAR = 0.9
/** How far past a doorway a cart is clear of the door's leaf. */
const INSIDE = 2.8
/** The two rule lamps, proud of the back wall beside the first door, and how high each is. */
const LAMPS: Spot = [7.65, 0.3]
const RULES: readonly number[] = [1.8, 1.2]
/** Both lamps at once: a cart in a train is read as it runs. */
const BOTH = 2
const WIRE: readonly Spot[] = [
  [7.65, 0.35],
  [7.65, 3],
  [7, 3],
]
const TAKES = 3.3 / PULSE
const BOARD: Spot = [1.5, 5.1]
const WORKER: Spot = [0.8, 5.4]
/** The board's three lines for slips, from the foot of its pole, and the newest slip, to look at. */
const LINES: readonly number[] = [2.02, 1.8, 1.58]
const SLIP: Point = [1.5, 5.15, 2]
/** Down the line toward the tunnel, where the clerk looks with nothing on its way. */
const AWAY: Point = [10.5, LINE, 0.8]

/**
 * The cart, and the server on it: small enough to stand between the cart's sides, so that it is
 * seen to ride in a cart and not to slide along the floor. The cart is 1.02 long.
 */
const CART = 0.6
const SERVER = 0.4
const LONG = 1.02
/** It gathers pace and brakes like something with weight on it. */
const ROLLS = 7
const TRAIN = 9
const GATHER = 16
const BRAKE = 24
/** What it still has on when it meets the doorway: it stops against it. */
const BUMP = 2
/** The rock of a cart on its wheels: how stiff, how damped, and how far a change of pace tips it. */
const STIFF = 256
const DAMP = 11.2
const LURCH = 1.28
/** A quarter turn onto a spur, a rule's three flickers, the beat held at the second turning. */
const TURNS = 0.15
const FLICKERS = 0.4
const HELD = 0.25
/** The points go over, past their place and back. */
const SNAPS = 0.12
/** How far apart the carts of a train leave the tunnel. */
const APART = 0.15
/** A slip: his head goes to the board, then his arm, and it lands. */
const LIFTS = 0.15
const SLAPS = 0.45
const LOWERS = 0.8
const WRITES = 0.95
/** The round it plays alone: when each rung is reached, and when each server lands. */
const ROUND = 26
const ALONE: readonly (readonly [number, Rung])[] = [
  [0, 'arrive'],
  [0.65, 'allow'],
  [1.3, 'canary'],
  [1.95, 'default'],
  [2.6, 'none'],
  [7, 'arrive'],
  [7.65, 'allow'],
  [8.3, 'none'],
  [14, 'arrive'],
  [14.65, 'allow'],
  [15.3, 'canary'],
  [15.95, 'default'],
  [17.25, 'none'],
]
const LANDS: readonly number[] = [8.3, 2.6, 17.25]
const FILLS = 12.5
const EMPTIES = 22

type Rung = 'none' | 'arrive' | 'allow' | 'canary' | 'default'

interface Told {
  at: Rung
  /** Servers placed so far at each door, in the doors' order. */
  placed: readonly number[]
  full: boolean
  /** The room is giving itself these, with nothing published. */
  own: boolean
}

/** A server on its cart. */
interface Cart {
  rack: Rack
  /** The door whose turning it takes: the last, the whole line, until it has been placed. */
  door: number
  /** How far it has come from the tunnel, along the line and then up its spur. */
  s: number
  speed: number
  /** Where it is to stop next, and how fast it goes on the way. */
  stop: number
  cruise: number
  /** When it began to turn onto its spur, and how long the turn takes. */
  turned: number
  turns: number
  /** How far its nose is tipped down, and how fast that is changing. */
  tip: number
  sway: number
  /** When it last came to rest, and when its lamps began to come on. */
  rested: number
  woke: number
  /** Its door is known. */
  placed: boolean
  /** Sent to a runtime with no room: it stays dark at the shut door. */
  waits: boolean
  /** Sent on through its door, by the next one for it or by starting over. */
  through: boolean
  /** Which rule lamp is lit for it, if a rule took it, and since when. */
  rule: number
  took: number
}

/** What the cart being read is told next: each waits for the one before to be done. */
type Order = { kind: 'read'; rule: number } | { kind: 'pass' } | { kind: 'send'; door: number; rule: number }

/** A slip on the board: when it was slapped on, its line, when it last dropped one, when it came off. */
interface Slip {
  on: number
  line: number
  moved: number
  off: number
}

export class RuntimesScene implements RoomScene {
  private carts: Cart[] = []
  /** How many carts there have been: each rack blinks in a time of its own. */
  private made = 0
  /** The one cart that stops to be read, what it has still to be told, and what it is doing. */
  private walker: Cart | null = null
  private bound = false
  private orders: Order[] = []
  private act: Order | null = null
  private began = SETTLED
  /** The train still to leave the tunnel, when the last cart left, and when the last joined. */
  private train: { door: number; waits: boolean }[] = []
  private left = SETTLED
  private joined = SETTLED
  /** Servers with no place at the shut door, waiting out of sight up the tunnel. */
  private parked = 0
  /** The points: set over toward the first door, and when they last snapped. */
  private over = false
  private snapped = SETTLED
  /** The second door: open, and when it was last thrown or swung. */
  private open = true
  private swung = SETTLED
  /** The board: its slips, whether one is owed, and when the clerk last turned to write one. */
  private slips: Slip[] = []
  private owed = false
  private writes = SETTLED
  private posted = SETTLED
  private readonly hand = bodyAt(WORKER, [1, 0])
  private gaze = 0
  private nod = 0
  private was: Told | null = null
  /** The held picture is what stands. */
  private held = false
  /** The round it plays alone opens with a cart stopped at the switch, being read. */
  private own = 2

  step(view: View): void {
    const { clock } = view
    const told = this.told(view)
    const was = this.was
    this.was = told

    // Only changes are acted out. On the first frame, or held still, every part is simply put
    // where it should be; after that, whenever the values start, stop or jump, what stands
    // stays, and only the rung and the door are caught up with.
    if (view.still) {
      if (!this.held) this.hold()
      this.held = true
    } else {
      if (was === null) this.join(told, clock)
      else this.follow(told, this.held || told.own !== was.own ? null : was, clock)
      this.held = false
      this.play(view, told)
    }
    this.draw(view)
  }

  /** A cart with a dark server on it, at rest, `s` along the way to a door. */
  private cart(door: number, s: number): Cart {
    this.made += 1
    return {
      rack: new Rack(3, 3, 'off', this.made),
      door,
      s,
      speed: 0,
      stop: s,
      cruise: ROLLS,
      turned: s > cornerOf(door) ? SETTLED : NEVER,
      turns: TURNS,
      tip: 0,
      sway: 0,
      rested: SETTLED,
      woke: SETTLED,
      placed: false,
      waits: false,
      through: false,
      rule: -1,
      took: NEVER,
    }
  }

  /** A server standing lit in a doorway, as if it had always been there. */
  private standing(door: number, power: 'on' | 'booting'): Cart {
    const cart = this.cart(door, cornerOf(door) + UP)
    cart.placed = true
    cart.rack.settle(3, power)
    return cart
  }

  /** One held moment, for less motion: a rule taking a server. */
  private hold(): void {
    const taken = this.cart(0, SWITCH)
    taken.placed = true
    taken.stop = SWITCH + UP
    taken.rule = 0
    taken.took = SETTLED
    // Every lamp held lit: nothing blinks.
    this.carts = [this.standing(1, 'booting'), taken]
    this.walker = null
    this.bound = false
    this.orders = []
    this.act = null
    this.train = []
    this.parked = 0
    this.over = true
    this.snapped = SETTLED
    this.open = true
    this.swung = SETTLED
    this.slips = [{ on: SETTLED, line: 0, moved: SETTLED, off: NEVER }]
    this.owed = true
    this.joined = SETTLED
    this.writes = SETTLED
    this.posted = SETTLED
    this.hand.arm = 0
  }

  /** The first frame: whatever the values say has happened already stands where it ended. */
  private join(told: Told, clock: number): void {
    this.open = !told.full
    // Alone, the round starts with a lit server already at the first and second doors.
    told.placed.forEach((count, door) => {
      const stands = told.own ? door < 2 : count > 0 && !(door === 1 && told.full)
      if (stands) this.carts.push(this.standing(door, 'on'))
    })
    if (told.at === 'none') return
    // A server is on the ladder: its cart stands where that rung is read. Alone, the first frame
    // is the middle of things: the second rule's lamp is flickering, and the cart is to go on.
    const walker = this.cart(2, told.at === 'default' && !told.own ? TURNING : SWITCH)
    this.carts.push(walker)
    this.walker = walker
    if (told.own) {
      this.act = { kind: 'read', rule: 1 }
      this.began = clock
      this.orders = [{ kind: 'pass' }]
    } else if (told.at === 'allow' || told.at === 'canary') {
      this.act = { kind: 'read', rule: told.at === 'allow' ? 0 : 1 }
      this.began = clock
    }
  }

  /**
   * Acts on what has changed. With no `was` the values have only just started, stopped or jumped:
   * the numbers are taken as they are, and only the rung is caught up with.
   */
  private follow(told: Told, was: Told | null, clock: number): void {
    let more = told.placed.map((count, door) => count - (was ? (was.placed[door] ?? 0) : count))
    if (more.some((count) => count < 0)) {
      this.startOver(clock)
      more = told.placed.map((count) => Math.min(count, 12))
    }
    // One more is one server for that door: the one on the ladder if it has not been placed yet,
    // and otherwise one more cart in the train.
    let next = false
    more.forEach((count, door) => {
      for (let n = 0; n < count; n++) {
        if (this.walker && !this.bound) {
          this.orders.push({ kind: 'send', door, rule: was?.at === 'canary' ? 1 : 0 })
          this.bound = true
          // Placed while the ladder is still being walked: another server has taken its place.
          next = told.at !== 'none'
        } else this.couple(door, told.full, clock)
      }
    })
    const changed = !was || told.at !== was.at
    if (changed && told.at !== 'none' && (!this.walker || this.bound || (was && told.at === 'arrive')))
      next = true
    if (next) this.arrive(told.full, clock)
    if (!(next || changed) || !this.walker) return
    if (told.at === 'allow') this.orders.push({ kind: 'read', rule: 0 })
    else if (told.at === 'canary') this.orders.push({ kind: 'read', rule: 1 })
    else if (told.at === 'default') this.orders.push({ kind: 'pass' })
    else if (told.at === 'none' && !this.bound) {
      // Off the ladder with nothing said of where it went: the default has it.
      this.orders.push({ kind: 'send', door: told.full ? 2 : 1, rule: 0 })
      this.bound = true
    }
  }

  /**
   * A new server rolls out of the dark. One still on the line goes straight to its door with no
   * more stops, and this one is sent behind it.
   */
  private arrive(full: boolean, clock: number): void {
    if (this.walker) {
      const sent = this.orders.find((order) => order.kind === 'send')
      this.dispatch(this.walker, sent?.door ?? (full ? 2 : 1), sent?.rule ?? 0, full, clock)
    }
    const walker = this.cart(2, 0)
    walker.stop = SWITCH
    this.carts.push(walker)
    this.walker = walker
    this.bound = false
    this.orders = []
    this.act = null
  }

  /** Sends a cart to a door, or, where the default has no room, to wait at its shut door. */
  private dispatch(cart: Cart, door: number, rule: number, full: boolean, clock: number): void {
    // A cart already past a door's turning is not sent back to it: it takes the next.
    let to = door
    while (to < 2 && cart.s > cornerOf(to) + 0.001) to += 1
    cart.placed = true
    cart.door = to
    if (to === 1 && full) {
      const waiting = this.waiting()
      cart.waits = true
      // There is no place for a third: it rolls back up the line into the tunnel.
      cart.stop = waiting === 0 ? TURNING + UP : waiting === 1 ? TURNING + BEHIND : 0
      if (waiting > 1) return
    } else {
      cart.stop = cornerOf(to) + UP
      if (to === 0) {
        cart.rule = rule
        cart.took = clock
      }
    }
    this.owed = true
    this.joined = clock
  }

  /** How many dark servers are waiting at the shut door, or on their way to. */
  private waiting(): number {
    return (
      this.carts.filter((cart) => cart.waits && !cart.through && cart.stop > 0).length +
      this.train.filter((joining) => joining.waits).length
    )
  }

  /** One more cart for the train. With the default full, two wait at its door and no more are sent. */
  private couple(door: number, full: boolean, clock: number): void {
    const waits = door === 1 && full
    if (waits && this.waiting() > 1) return
    this.train.push({ door, waits })
    this.owed = true
    this.joined = clock
  }

  /** Sends a cart on through its door into the hall. */
  private leave(cart: Cart, cruise: number): void {
    cart.through = true
    cart.stop = cornerOf(cart.door) + GONE
    cart.cruise = Math.max(cart.cruise, cruise)
  }

  /** Starting over: every server at a door rolls on through it, and the slips drop off the board. */
  private startOver(clock: number): void {
    for (const cart of this.carts) {
      if (cart.placed && !cart.through && cart.stop > 0) this.leave(cart, ROLLS)
      // One on its way back up the line is not kept for later.
      else if (cart.stop === 0) cart.waits = false
    }
    this.train = []
    this.parked = 0
    this.owed = false
    this.slips.forEach((each, n) => {
      if (each.off === NEVER) each.off = clock + n * 0.07
    })
  }

  /** Plays the room on by one frame. */
  private play(view: View, told: Told): void {
    const { clock, dt } = view
    /** True on the frame the clock passes a moment. */
    const just = (when: number) => clock >= when && clock - dt < when

    // The train: carts leave the tunnel one behind another, already rolling, and stop for nothing.
    // Those ahead for the same door will not be the last for it: they go straight through.
    const joining = this.train[0]
    if (joining && clock - this.left >= APART) {
      this.train.shift()
      this.left = clock
      const cart = this.cart(joining.door, 0)
      cart.placed = true
      cart.speed = TRAIN
      cart.cruise = TRAIN
      cart.waits = joining.waits
      if (joining.waits) cart.stop = TURNING + (this.waiting() === 0 ? UP : BEHIND)
      else {
        cart.stop = cornerOf(joining.door) + UP
        if (joining.door === 0) cart.rule = BOTH
        for (const ahead of this.carts)
          if (ahead.door === cart.door && ahead.placed && !ahead.waits && !ahead.through && ahead.speed > 0)
            this.leave(ahead, TRAIN)
      }
      this.carts.push(cart)
    }

    // With no room, the server at the second door rolls through it before the door is shut. The
    // door stands as `full` says, and is thrown open for whatever has to go through it.
    if (told.full)
      for (const cart of this.carts)
        if (cart.door === 1 && cart.placed && !cart.waits && !cart.through) this.leave(cart, ROLLS)
    const passing = this.carts.some(
      (cart) => cart.door === 1 && cart.through && cart.s < TURNING + UP + INSIDE,
    )
    if ((!told.full || passing) !== this.open) {
      this.open = !this.open
      this.swung = clock
    }
    const passable = this.open && clock - this.swung >= HITS
    if (!told.full && passable) {
      // Room again: whatever waited comes on where it stands, and once those have sorted
      // themselves out what was out of sight is sent.
      for (const cart of this.carts) if (cart.waits && cart.stop > 0) cart.waits = false
      if (clock - this.swung >= 2) for (; this.parked > 0; this.parked--) this.couple(1, false, clock)
    }

    for (const cart of this.carts) {
      if (!cart.placed || cart.waits) continue
      const corner = cornerOf(cart.door)
      const doorway = corner + UP
      if (!cart.through) {
        const standing = cart.speed === 0 && cart.s === cart.stop
        // Its lamps come on a moment after it has stopped.
        if (standing && cart.rack.power === 'off' && clock - cart.rested >= 0.15) {
          cart.rack.set('on', clock)
          cart.woke = clock
        }
        // At most one lit server stands at a door. Two that waited both come on, and then the
        // first rolls through and the second moves up to the doorway.
        if (standing && cart.stop < doorway && clock - cart.woke >= 1.1) cart.stop = doorway
      }
      // As the next for a door turns onto its spur, the one standing there rolls on through.
      const turning = cart.turned !== NEVER || (cart.speed > 0 && cart.s >= corner - cart.speed * 0.35)
      if (cart.stop < doorway || !turning) continue
      for (const ahead of this.carts) {
        if (ahead === cart) break
        if (ahead.door === cart.door && ahead.placed && !ahead.waits && !ahead.through)
          this.leave(ahead, cart.cruise)
      }
    }

    // The rules and the points. A cart in a train is read as soon as it is out of the tunnel. A
    // rule's lamp is lit first, the pulse runs from it, and only then do the points go over; they
    // snap back when the cart is clear.
    for (const cart of this.carts)
      if (cart.rule === BOTH && cart.took === NEVER && cart.s >= 1) cart.took = clock
    const nearest = this.carts.find((cart) => cart.stop >= cart.s && cart.s < SWITCH + PAST)
    const over = nearest !== undefined && nearest.door === 0 && clock >= nearest.took + TAKES
    if (over !== this.over) {
      this.over = over
      this.snapped = clock
    }
    const set = this.over && clock - this.snapped >= SNAPS

    this.carts.forEach((cart, n) => {
      const corner = cornerOf(cart.door)
      let stop = cart.stop
      // Nothing goes through a door still shut, and a cart stopped at the switch does not take
      // the first spur until the points are over. (A train does not wait: they snap ahead of it.)
      if (cart.door === 1 && !passable && cart.s <= corner + UP) stop = Math.min(stop, corner + UP)
      // It turns with the rail: on the spot if it was stopped at its turning, and as it runs if not.
      const cornered = cart.speed === 0 && Math.abs(cart.s - corner) < 1e-6
      if (cart.door === 0 && cornered && !set) stop = corner
      if (stop > corner && cart.turned === NEVER) {
        if (cornered) cart.turned = clock
        else if (cart.speed > 0 && cart.s >= corner - 0.2) {
          cart.turned = clock
          cart.turns = clamp(0.45 / cart.speed, 0.04, TURNS)
        }
      }
      if (cornered && stop > corner && clock - cart.turned < cart.turns) stop = corner

      const before = cart.speed
      const far = stop - cart.s
      if (Math.abs(far) < 1e-6) cart.speed = 0
      else {
        const way = Math.sign(far)
        // Up a spur it stops against the doorway, with a bump. Down the hall it does not stop.
        const meets = cart.through ? cart.cruise : cart.s > corner && stop <= corner + UP ? BUMP : 0
        let pace = Math.min(
          Math.abs(before) + GATHER * dt,
          cart.cruise,
          Math.sqrt(2 * BRAKE * Math.abs(far) + meets * meets),
        )
        // It keeps off the cart in front of it: one on the line ahead, or on its own spur.
        if (way > 0)
          for (let m = 0; m < n; m++) {
            const ahead = this.carts[m] as Cart
            const on = ahead.door === cart.door || (ahead.s <= cornerOf(ahead.door) && ahead.s <= corner)
            if (!on || ahead.stop < ahead.s || ahead.s <= cart.s) continue
            const gap = Math.max(0, ahead.s - cart.s - LONG)
            pace = Math.min(pace, Math.max(0, ahead.speed) + Math.sqrt(2 * BRAKE * gap))
          }
        const move = Math.min(Math.abs(far), pace * dt)
        cart.s += way * move
        cart.speed = way * pace
        // (One gone down its hall is taken away below, still rolling: nothing behind it brakes.)
        if (Math.abs(far) - move < 1e-6 && !cart.through) {
          cart.s = stop
          cart.speed = 0
          cart.rested = clock
        }
      }
      // What it loses in pace goes into its nose: it dips as it brakes, and rocks back level.
      cart.sway += (before - cart.speed) * LURCH
      for (let left = dt; left > 0; left -= 1 / 120) {
        const tick = Math.min(left, 1 / 120)
        cart.sway -= (STIFF * cart.tip + DAMP * cart.sway) * tick
        cart.tip = clamp(cart.tip + cart.sway * tick, -0.2, 0.2)
      }
    })
    // One gone down its hall is gone; one back in the tunnel waits there, out of sight.
    this.carts = this.carts.filter((cart) => {
      if (cart.through) return cart.s < cornerOf(cart.door) + GONE - 1e-6
      if (cart.stop > 0 || cart.s > 0) return true
      if (cart.waits) this.parked += 1
      return false
    })

    // The cart being read: each thing it is told waits for the one before it to be done, and
    // for the cart to have stopped.
    for (let cart = this.walker; cart; ) {
      if (!this.act) {
        const next = this.orders[0]
        if (!next || cart.speed !== 0 || cart.s !== cart.stop) break
        this.orders.shift()
        // A rule is read at the switch: a cart that is past it is past the rules.
        if (next.kind === 'read' && cart.s > SWITCH) continue
        if (next.kind === 'send') {
          this.dispatch(cart, next.door, next.rule, told.full, clock)
          this.walker = null
          this.bound = false
          break
        }
        this.act = next
        this.began = clock
        if (next.kind === 'pass') cart.stop = Math.max(cart.stop, TURNING)
      }
      // A rule's lamp flickers three times, and until it is known what the rule made of it.
      const done =
        this.act.kind === 'read'
          ? clock - this.began >= FLICKERS && this.orders.length > 0
          : cart.speed === 0 && cart.s === cart.stop && clock - cart.rested >= HELD
      if (!done) break
      this.act = null
    }

    // The clerk writes it down once the last cart has stopped at its door and no more have joined.
    const settled = (cart: Cart) =>
      cart.through
        ? cart.s > cornerOf(cart.door) + UP + CLEAR
        : cart.speed === 0 &&
          cart.s === cart.stop &&
          (cart.waits ? clock - cart.rested >= 0.4 : cart.rack.power !== 'off' && clock - cart.woke >= 0.55)
    const quiet = this.train.length === 0 && clock - this.joined >= 0.6
    if (this.owed && quiet && this.carts.every((cart) => cart === this.walker || settled(cart))) {
      this.owed = false
      this.writes = clock
    }
    if (just(this.writes + SLAPS)) {
      // The newest goes on at the top; the others drop a line, and the last is pushed off.
      for (const each of this.slips) {
        each.line += 1
        each.moved = clock
        if (each.line >= LINES.length && each.off === NEVER) each.off = clock
      }
      this.slips.unshift({ on: clock, line: 0, moved: SETTLED, off: NEVER })
      this.posted = clock
    }
    this.slips = this.slips.filter((each) => clock - each.off < 1.5)
  }

  /** Draws the room as it stands. */
  private draw(view: View): void {
    const { clock, dt, box } = view

    // The three doors, the same door three times. The first and third stand open with their
    // lamps lit; the second is thrown open against its stop, or swung shut against its frame.
    const swing = clock - this.swung
    DOORS.forEach((u, n) => {
      if (n !== 1) door(box, view.place(u, FRAME), 1, true)
      else if (this.open) door(box, view.place(u, FRAME), thrown(swing), swing >= HITS)
      else
        door(
          box,
          view.place(u, FRAME),
          1 - clamp(swing / SHUTS) ** 2,
          swing < SHUTS,
          0.4 * given(swing - SHUTS),
        )
    })

    // The rules: two lamps beside the first door, dark unless a cart is being read.
    const flickers =
      this.act?.kind === 'read' && Math.floor((clock - this.began) / (FLICKERS / 6)) % 2 === 0
        ? this.act.rule
        : -1
    const lamps = partsAt(box, view.place(LAMPS[0], LAMPS[1]))
    RULES.forEach((height, rule) => {
      const lit =
        flickers === rule ||
        this.carts.some(
          (cart) =>
            (cart.rule === rule || cart.rule === BOTH) && clock >= cart.took && cart.s < SWITCH + CLEAR,
        )
      lamps(0, height, -0.15, 0.4, 0.4, 0.3, lit ? 80 : 60, lit ? Kind.lamp : Kind.dark, lit ? LIT : 0)
    })
    // The wire from them to the points, and a pulse for each cart a rule has taken.
    wireIn(view, WIRE)
    for (const cart of this.carts) if (cart.rule >= 0) runIn(view, WIRE, clock - cart.took)
    const snap = clock - this.snapped
    const thrownOver = overshoot(clamp(snap / SNAPS))
    points(view, this.over ? thrownOver : 1 - thrownOver)
    for (const side of [3.25, 3.75]) {
      const [x, y, z] = view.at(7, side)
      spark(box, x, y, z, snap, view.inside)
    }

    // The carts, each with its server facing us whichever way the cart points. The warm light on
    // the floor is in front of the server that came on last.
    let last: Cart | undefined
    for (const cart of this.carts) {
      const corner = cornerOf(cart.door)
      const [u, v] =
        cart.s <= corner ? [TUNNEL - cart.s, LINE] : [DOORS[cart.door] as number, LINE - (cart.s - corner)]
      const turned = ease(clamp((clock - cart.turned) / cart.turns))
      const heading = -Math.PI / 2 - (turned * Math.PI) / 2
      const whole = tipped(box, view.at(u, v), view.facing(heading), cart.tip)
      const lit = cart.s > corner + UP ? unlit(view, whole) : whole
      tub(lit, view.place(u, v, 0, heading, CART))
      // (Its trays stand 0.2 proud of its front edge: the whole of it is set in the cart's middle.)
      cart.rack.draw(
        lit,
        view.place(u, v + ((RACK_DEEP - 0.2) * SERVER) / 2, CART_BED * CART, 0, SERVER),
        clock,
      )
      if (cart.rack.power !== 'off' && cart.s < corner + UP + CLEAR && (!last || cart.woke >= last.woke))
        last = cart
    }
    if (last)
      view.light(DOORS[last.door] as number, 2.3, 0.7, 2.2, 0.8 * clamp((clock - last.woke) / 0.9, 0.2))

    // The board and its slips.
    const sign = view.place(BOARD[0], BOARD[1])
    board(box, sign, 0.9, 0.8, 1.4, slap(clock - this.posted))
    for (const each of this.slips) {
      const fell = clock - each.moved
      const line = LINES[Math.min(each.line, LINES.length - 1)] as number
      const from = LINES[Math.max(0, Math.min(each.line, LINES.length) - 1)] as number
      // Dropped a line, it falls and jolts.
      const jolt = fell > 0.1 && fell < 0.24 ? 0.03 * Math.sin(((fell - 0.1) / 0.14) * Math.PI) : 0
      const y = lerp(from, line, clamp(fell / 0.1) ** 2) + jolt
      slip(box, sign, 0, y, 0.7, 0.16, clock - each.on, clock >= each.off ? clock - each.off : -1)
    }

    // The clerk. His head follows the newest cart to its door; when it has stopped there he
    // looks to the board, and only then does his arm go up. Then back to the tunnel.
    const hand = this.hand
    const writing = clock - this.writes
    const newest = this.carts[this.carts.length - 1]
    const watched =
      newest && (newest === this.walker || this.owed) && newest.s < cornerOf(newest.door) + UP + CLEAR
        ? newest
        : undefined
    let look = AWAY
    if (writing < WRITES) look = SLIP
    else if (watched) {
      const corner = cornerOf(watched.door)
      look =
        watched.s <= corner
          ? [TUNNEL - watched.s, LINE, 0.9]
          : [DOORS[watched.door] as number, LINE - (watched.s - corner), 0.9]
    }
    const [gaze, nod] = headTo(hand, look, view.handed, 0.3)
    const comes = view.still ? 1 : 1 - Math.exp(-dt * 9)
    this.gaze += (gaze - this.gaze) * comes
    this.nod += (nod - this.nod) * comes
    const raised = writing >= LIFTS && writing < LOWERS
    const arm = reach(hand, raised ? (writing < SLAPS - 0.05 ? -1.9 : -2.3) : 0, dt, raised ? 10 : 5)
    const head = { gaze: this.gaze, nod: this.nod }
    // The board's face is on the camera's side of him, and so is the arm he slaps it with.
    worker(
      view,
      hand,
      Math.abs(arm) < 0.02 ? head : view.handed < 0 ? { ...head, tool: arm } : { ...head, other: arm },
    )
  }

  /** What the demonstration says, or, alone, the same values on a clock of its own. */
  private told(view: View): Told {
    // One held moment: a rule taking a server. (The demonstration says nothing then.)
    if (view.still) return { at: 'allow', placed: [0, 1, 0], full: false, own: true }
    const said = view.showing
    if (said) {
      const at = String(said.at)
      return {
        at: at === 'arrive' || at === 'allow' || at === 'canary' || at === 'default' ? at : 'none',
        placed: [Number(said.fleet) || 0, Number(said.a) || 0, Number(said.b) || 0],
        full: said.full === true,
        own: false,
      }
    }
    this.own += view.dt
    const t = this.own % ROUND
    const rounds = Math.floor(this.own / ROUND)
    let at: Rung = 'none'
    for (const [from, rung] of ALONE) if (t >= from) at = rung
    return {
      at,
      placed: LANDS.map((lands) => rounds + (t >= lands ? 1 : 0)),
      full: t >= FILLS && t < EMPTIES,
      own: true,
    }
  }
}

/**
 * Kit candidate: the points, one block of rail over the junction in front of the first door. Two
 * blades hinged at the heel, where the carts come from: straight on down the line, or, `over`,
 * swung toward the spur. `over` goes a little past 0 and 1 as they snap.
 */
function points(view: View, over: number): void {
  const swing = (over * Math.PI) / 4
  const along = [-Math.cos(swing), -Math.sin(swing)] as const
  const round = view.facing(headingOf(along))
  for (const side of [-0.25, 0.25]) {
    const [x, y, z] = view.at(7 + along[0] * 0.42, LINE + side + along[1] * 0.42)
    view.box(x - 0.05, y, z - 0.42, 0.1, 0.07, 0.84, 215, Kind.iron, 0, view.inside, round)
  }
}

/**
 * Kit candidate: a way to draw a piece tipped as one thing. Whatever is drawn with the box-drawer
 * this gives back is turned about a line across the floor through `pivot`: the end `heading`
 * points to goes down by `angle`. It is for pieces whose parts are not tipped themselves, and it
 * leaves alone any part that does not stand square to the heading (a load that keeps facing one
 * way while what carries it turns under it).
 */
function tipped(box: Box, pivot: readonly [number, number, number], heading: number, angle: number): Box {
  if (Math.abs(angle) < 0.002) return box
  const sin = Math.sin(heading)
  const cos = Math.cos(heading)
  const down = Math.sin(angle)
  const level = Math.cos(angle)
  return (x, y, z, sx, sy, sz, tone, kind, group, inside, round = 0, _tipped = 0, solid = 1) => {
    const off = round - heading
    if (Math.abs(Math.sin(2 * off)) > 0.05) {
      box(x, y, z, sx, sy, sz, tone, kind, group, inside, round, 0, solid)
      return
    }
    // A part lying across the heading is the same box as one lying along it with its sides swapped.
    const across = Math.abs(Math.sin(off)) > 0.5
    const wide = across ? sz : sx
    const deep = across ? sx : sz
    const dx = x + sx / 2 - pivot[0]
    const dy = y + sy / 2 - pivot[1]
    const dz = z + sz / 2 - pivot[2]
    const side = dx * cos - dz * sin
    const fore = dx * sin + dz * cos
    const up = dy * level - fore * down
    const out = dy * down + fore * level
    box(
      pivot[0] + side * cos + out * sin - wide / 2,
      pivot[1] + up - sy / 2,
      pivot[2] - side * sin + out * cos - deep / 2,
      wide,
      sy,
      deep,
      tone,
      kind,
      group,
      inside,
      heading,
      angle,
      solid,
    )
  }
}

/**
 * Kit candidate: a box-drawer for what leaves a lit room by a door into an unlit hall. A part
 * whose middle is behind the room's back wall is lit by nothing, as the hall is; a lamp on it
 * still glows.
 */
function unlit(view: View, box: Box): Box {
  const [ox, , oz] = view.at(0, 0)
  const [bx, , bz] = view.at(0, 1)
  return (x, y, z, sx, sy, sz, tone, kind, group, inside, round, tip, solid) => {
    const v = (x + sx / 2 - ox) * (bx - ox) + (z + sz / 2 - oz) * (bz - oz)
    box(x, y, z, sx, sy, sz, tone, kind, group, v < 0 ? DARK : inside, round, tip, solid)
  }
}

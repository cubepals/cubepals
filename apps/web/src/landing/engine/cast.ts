/**
 * Who moves on the chunk, and what they are doing there.
 *
 * There are few of them, and each has room. On the grass, friends who join walk in along the path,
 * go to a place of their own and get on with something unhurried: one fells the tree, one builds,
 * one fishes. A couple of sheep graze, and the chimney smokes while anyone is in. Each way to play
 * that the page offers puts one small story there that can be taken in at a glance (a torch and
 * one of the dead at dusk for survival, something built out of nothing for creative, a water
 * wheel for the Create mod).
 *
 * Under the grass there is one worker, in pale overalls with a lamp on the helmet, who is in
 * whichever room the page has reached and is doing that room's job: watching the gate, minding
 * the furnaces, carrying a pack to the table, shelving a backup, swinging at the vein. It is the
 * page's whole argument as a character: somebody does all of this, and it isn't you.
 *
 * How they move is kept plain, because a figure this small is unsettling the moment it hurries,
 * slides or snaps. Everyone walks the way they face, along straight legs of the grid, and turns
 * round on the spot between them: nobody is ever facing one way and then another. A walk gathers
 * pace and comes to a stop; nobody starts or halts in one frame. The legs swing from the hip with
 * the ground covered, so feet don't skate. Routes are laid out by hand so that no two ever cross
 * while both are walked, and whoever waits for someone waits a good way off. What is held is held
 * in a hand, and each of the friends is their own person (engine/models.ts).
 *
 * Everything here is drawn fresh each frame as loose boxes (engine/models.ts): none of it is part
 * of the world's grid, so none of it can be dug and none of it needs the world packed again.
 */
import { CELLAR, LIT, type RoomKey } from './chunk'
import { clamp, ease } from './curves'
import {
  type Box,
  blowOf,
  cube,
  DEAD,
  figure,
  KAI,
  MOSS,
  NOOR,
  type Skin,
  sheep,
  strikeArm,
  veiled,
} from './models'
import { type Light, Rooms, type Showing } from './rooms'
import { SCENES } from './scenes'
import {
  chest,
  drop,
  furnace,
  overshoot,
  type Place,
  puff,
  pulse,
  Rack,
  SETTLED,
  type Slot,
  sequence,
  slotsOf,
  smallWorld,
  UNIT,
  windup,
  wire,
} from './server'
import { type Body, bodyAt, EASE, headingOf, reach, type Spot, STROLL, strideOf, turn, walk } from './walk'
import { hash3, Kind } from './world'

/** Throws a few chips from a place, mostly the way `out` points. */
export type Chips = (
  at: readonly [number, number, number],
  out: readonly [number, number, number],
  count: number,
  /** How big each chip is, in blocks: a block's own chips, unless said. */
  size?: number,
) => void

/** The ways to play the page offers, and the group sizes (sections/choice.ts has the same keys). */
export type Play = 'survival' | 'creative' | 'hardcore' | 'smooth' | 'create'
export type Party = '5' | '10' | '20' | 'more'

const TURN = Math.PI * 2

/** How fast the dead go, and a sheep, in blocks a second. */
const SHAMBLE = 0.6
const AMBLE = 0.45
/** How long someone takes to appear at the chunk's edge or come up out of the ground, and to go. */
const ARRIVES = 0.5
/** How long one way to play takes to thin away, and the next to come in after it. */
const CHANGES = 0.7

/** A body out on the grass as a figure to draw: walking at its pace, or standing. */
const walking = (body: Body, cruise: number) => ({
  x: body.x,
  y: 1,
  z: body.z,
  heading: body.heading,
  phase: body.phase,
  stride: strideOf(body, cruise),
  inside: 0,
})
const standing = (body: Body, life: number | undefined) => ({
  ...walking(body, 1),
  phase: 0,
  stride: 0,
  life,
})

/** Who the friends are, in the order they join. */
const FRIENDS: readonly Skin[] = [MOSS, KAI, NOOR]

/** Where everyone arrives and leaves: the end of the path, at the chunk's edge. */
const EDGE: Spot = [15.6, 4.5]
/** Where whoever typed the address stops, a little way up the path, clear of the signpost. */
const CALLS: Spot = [10.8, 4.5]
/** The path from the door to the edge runs along here. */
const PATH_Z = 4.5

/**
 * Where each friend goes, which way they face there, and what they do. Each is reached by walking
 * the path and then turning off it once, and no two are within three blocks of each other.
 */
const HAUNTS: readonly { spot: Spot; face: Spot; job: 'chop' | 'build' | 'fish' }[] = [
  { spot: [12.3, 1.5], face: [1, 0], job: 'chop' },
  { spot: [11.3, 8.0], face: [1, 0], job: 'build' },
  { spot: [8.5, 11.5], face: [1, 0], job: 'fish' },
]

/** What the builder puts up on their plot, a block at a time: a small tower with a lamp on it. */
const TOWER: readonly (readonly [number, number, number, number, number])[] = [
  ...[1, 2, 3].flatMap((y) =>
    (
      [
        [12, 7],
        [13, 7],
        [13, 8],
        [12, 8],
      ] as const
    ).map(([x, z]) => [x, y, z, y === 1 ? Kind.cobble : Kind.planks, y === 1 ? 150 : 250] as const),
  ),
  [12, 4, 7, Kind.lamp, 80],
]

interface Friend extends Body {
  haunt: number
  route: Spot[]
  state: 'coming' | 'busy' | 'going'
  /** Seconds at the job, and how many of its beats (a blow landed, a block set) have happened. */
  clock: number
  beat: number
  /** How much of them is there: they appear at the edge and go at it. */
  grow: number
}

/** Each sheep keeps to a patch of its own: the corners it ambles between, each a turn from the last. */
const PATCHES: readonly (readonly Spot[])[] = [
  [
    [4.6, 10.6],
    [2.6, 10.6],
    [2.6, 9.2],
    [4.6, 9.2],
  ],
  [
    [6.8, 13.8],
    [4.6, 13.8],
    [4.6, 15.0],
    [6.8, 15.0],
  ],
]

interface Grazer extends Body {
  to: number
  rest: number
  clock: number
  /** How far down its head is, 0 up to 1 grazing. */
  head: number
}

/**
 * Where the one who stays alive stands to meet the dead, and where they walk back to after: out
 * on the open grass in front, where there is nothing behind them to be lost against.
 */
const STAND: Spot = [5.2, 14.0]
const POST: Spot = [7.8, 14.0]
/**
 * How near the dead come before they are met: near enough for a blow, and far enough that there
 * is always grass between an outstretched arm and the torch.
 */
const REACH = 1.9
/** Where the dead come up, and where each stops: one along the front, one down from the house. */
const GRAVES: readonly { from: Spot; stop: Spot }[] = [
  { from: [0.9, 14.0], stop: [STAND[0] - REACH, STAND[1]] },
  { from: [5.2, 9.2], stop: [STAND[0], STAND[1] - REACH] },
]
/** How long one blow takes, and how far into it the blow lands. */
const BLOW = 1.3
const LANDS = 0.64

interface Mob extends Body {
  state: 'down' | 'rising' | 'coming' | 'waiting' | 'falling'
  /** Seconds in this state, or until it comes up while it is down. */
  t: number
}

interface Hero extends Body {
  state: 'stand' | 'strike' | 'after' | 'back' | 'rest' | 'out'
  t: number
  /** Which of the dead is being met. */
  aim: number
  struck: boolean
}

/** Someone walking up and down a line of their own, with a long stop at each end. */
interface Stroller extends Body {
  ends: readonly [Spot, Spot]
  toward: 0 | 1
  hold: number
  rests: number
  cruise: number
}

interface Scene {
  play: Play
  clock: number
  hero: Hero | null
  mobs: Mob[]
  strollers: Stroller[]
  /** Someone who stands and looks on: at the pond, or by what they have built. */
  idler: Body | null
  /** Creative: how high the builder hovers, how fast they are rising, and how far their arm is out. */
  hover: number
  rise: number
  reach: number
  /** Seconds since the scene was put on: whoever is in it grows in over the first of them. */
  age: number
  /** Seconds it has been on its way out, once another way to play is asked for: it shrinks away. */
  leaving: number
  /** Whether this is one held moment of the scene, for someone who asked for less motion. */
  still: boolean
}

/**
 * How much of a scene is there: it comes in out of scattered dots when it is put on, and thins
 * away into them when another way to play is asked for.
 */
const thereOf = (scene: Scene) =>
  ease(clamp(scene.age / CHANGES)) * (1 - ease(clamp(scene.leaving / CHANGES)))

/**
 * What creative builds, as blocks from the ground up: [x, y, z] from the site's corner, and
 * whether the block is the one of gold that finishes it. Each is a solid thing that reads from
 * any side (a flat picture made of blocks is only a picture from in front): a stepped pyramid, a
 * gate, and a winding stair.
 */
type Cell = readonly [number, number, number, boolean]
const SHAPES: readonly (readonly Cell[])[] = (() => {
  const pyramid: Cell[] = []
  for (let y = 0; y < 3; y++)
    for (let z = y; z < 5 - y; z++)
      for (let x = y; x < 5 - y; x++) {
        // Hollow, as a quick builder makes one: only the outside of each layer.
        const rim = x === y || z === y || x === 4 - y || z === 4 - y
        if (rim) pyramid.push([x, y + 1, z, y === 2])
      }
  const gate: Cell[] = []
  for (let y = 1; y <= 4; y++)
    for (const x of [0, 4]) for (const z of [1, 2]) if (y < 4) gate.push([x, y, z, false])
  for (let x = 0; x <= 4; x++) for (const z of [1, 2]) gate.push([x, 4, z, false])
  for (const z of [1, 2]) gate.push([2, 5, z, true])
  const stair: Cell[] = []
  const ring: Spot[] = [
    [1, 1],
    [2, 1],
    [3, 1],
    [3, 2],
    [3, 3],
    [2, 3],
    [1, 3],
    [1, 2],
  ]
  // A pillar up the middle, and two steps round it for every block it rises.
  for (let y = 1; y <= 6; y++) {
    stair.push([2, y, 2, false])
    for (const step of [2 * (y - 1), 2 * (y - 1) + 1]) {
      const [x, z] = ring[step % ring.length] as Spot
      stair.push([x, y, z, false])
    }
  }
  stair.push([2, 7, 2, true])
  return [pyramid, gate, stair]
})()
/**
 * The corner of the grass creative builds on: out in front, clear of the house, the tree and the
 * pond, so what is built stands by itself.
 */
const SITE = [4, 0, 11] as const
/** Where the one building hovers: behind what is built and above it, facing the way we look. */
const HOVER: Spot = [5.0, 9.9]
/** Creative: blocks set a second, how long a finished thing stands, and how long it takes to clear. */
const SETS = 4
const STANDS = 5.5
const CLEARS = 1.6
/** How fast the one building rises and comes down, in blocks a second: under a stroll. */
const HOVERS = 1.2

/** How much daylight each way to play is seen by, 0 night to 1 day. */
export const DAYLIGHT: Record<Play, number> = {
  survival: 0.5,
  creative: 1,
  hardcore: 0.2,
  smooth: 1,
  create: 1,
}

/** What each friend carries to their work, and where the arm that carries it is held. */
const CARRIES = {
  chop: { hold: 'axe', arm: strikeArm(0) },
  fish: { hold: 'rod', arm: -1.0 },
  build: { hold: undefined, arm: 0 },
} as const

/** The server in the vault: its rack, what stands round it, the small world over it and that world's own motion. */
interface Rig {
  rack: Rack
  chests: Slot[]
  cores: Slot[]
  play: Play
  was: Play | null
  swapped: number
  /** Which way the small world is turned, and how fast it is turning. */
  spin: number
  whirl: number
  /** How high the small world rides, and how fast it is moving: it is on a spring. */
  ride: number
  bob: number
  clock: number
}

export class Cast {
  private friends: Friend[] = []
  /** How much of the tower stands, and when its newest block was set. It stays while the server sleeps. */
  private built = 0
  private builtAt = -10
  /** Seconds until the next friend may set off, in or out: the path is walked one at a time. */
  private gate = 0
  /** Whether the last scene's own people are on the grass, and how much tower stood before they were. */
  private settledWas = false
  private builtOwn = -1
  /** How much smoke the chimney makes, 0 to 1. */
  private fire = 0
  /** The way to play that is on, and the one it took over from while that is still thinning away. */
  private scene: Scene | null = null
  private last: Scene | null = null
  /** The scenes of the rooms under the grass. */
  private readonly rooms = new Rooms(SCENES)
  private herd: Grazer[] = PATCHES.map((patch, index) => ({
    ...bodyAt(patch[0] as Spot, index === 0 ? [1, 0] : [0, -1]),
    to: 1,
    rest: 3 + index * 2.5,
    clock: index * 1.3,
    head: 1,
  }))
  private clock = 0
  /** Where a carried torch is just now, if anyone is carrying one: it lights the ground round it. */
  torch: readonly [number, number, number] | null = null
  /** The one who typed the address: where they are, how much of them is there, how long they have stood. */
  private caller: (Body & { grow: number; stood: number }) | null = null
  /** The server in the vault: how much of each part is there, and which small world it runs. */
  private rig: Rig | null = null
  /** Where the server's own light falls from, and how far it reaches, once it has been drawn. */
  glow: readonly [number, number, number, number] | null = null

  /** True while any friend is on the grass, on their way in or out as well as at their place. */
  get about(): boolean {
    return this.friends.length > 0
  }

  /**
   * The friends who have joined: `count` of them should be in the world. Each walks in along the
   * path, one at a time, turns off it to a place of their own and gets on with something: one
   * fells the tree, one builds, one fishes. When the count falls they walk back the way they came,
   * the nearest to the edge first. With `settled` nobody is seen arriving: whoever should be in is
   * already at their place. Round them the sheep graze, and the chimney smokes while anyone is in.
   * True while anything here should be drawn on every frame.
   */
  friendsStep(
    count: number,
    dt: number,
    box: Box,
    chips: Chips,
    home: number,
    still = false,
    settled = false,
  ): boolean {
    this.clock += dt
    this.torch = null
    const wanted = Math.min(count, HAUNTS.length)
    const placed = () =>
      HAUNTS.slice(0, wanted).map((haunt, index): Friend => {
        const friend: Friend = {
          ...bodyAt(haunt.spot, haunt.face),
          haunt: index,
          route: [],
          state: 'busy',
          clock: index * 2.3,
          beat: 0,
          grow: 1,
        }
        friend.arm = CARRIES[haunt.job].arm
        return friend
      })
    if (still) {
      // With less motion asked for, nobody walks in or out: whoever is in is at their place, the
      // tower stands if there is someone to have built it, and nothing moves.
      this.friends = placed()
      if (wanted > 1) this.built = TOWER.length
      for (const friend of this.friends) {
        const carries = CARRIES[(HAUNTS[friend.haunt] as (typeof HAUNTS)[number]).job]
        figure(box, standing(friend, undefined), FRIENDS[friend.haunt] ?? MOSS, {
          hold: carries.hold,
          tool: carries.hold ? carries.arm : undefined,
          gaze: 0,
        })
      }
      this.tower(box, home)
      this.graze(0, box)
      return false
    }
    // What the last scene put on the grass is that scene's: its three friends and its finished
    // tower are there while it is, and gone when the page is back at the top. The page changes
    // from one to the other with the grass out of sight, so nobody sees the cut.
    if (settled && this.builtOwn < 0) this.builtOwn = this.built
    if (!settled && this.builtOwn >= 0) {
      this.built = this.builtOwn
      this.builtOwn = -1
    }
    if (
      (settled &&
        (this.friends.length !== wanted || this.friends.some((friend) => friend.state !== 'busy'))) ||
      (!settled && this.settledWas)
    ) {
      this.friends = settled ? placed() : []
      // (The last scene finds the fire already going.)
      this.fire = settled && wanted > 0 ? 1 : 0
      if (settled && wanted > 1) this.built = TOWER.length
    }
    this.settledWas = settled

    // One sets off at a time, in or out, so nobody meets anybody on the path.
    this.gate = Math.max(0, this.gate - dt)
    const staying = this.friends.filter((friend) => friend.state !== 'going')
    const leaving = this.friends.some((friend) => friend.state === 'going')
    if (staying.length < wanted && !leaving && this.gate <= 0) {
      const free = HAUNTS.findIndex((_, index) => !this.friends.some((friend) => friend.haunt === index))
      const haunt = HAUNTS[free]
      if (haunt) {
        const friend: Friend = {
          ...bodyAt(EDGE, [-1, 0]),
          haunt: free,
          route: [[haunt.spot[0], PATH_Z], haunt.spot],
          state: 'coming',
          clock: 0,
          beat: 0,
          grow: 0,
        }
        // They arrive with what they came to use already in hand.
        friend.arm = CARRIES[haunt.job].arm
        this.friends.push(friend)
        this.gate = 2.4
      }
    } else if (staying.length > wanted && this.gate <= 0) {
      // Whoever has the shortest way out goes first, so nobody is walked past; and nobody is
      // turned round in mid-stride: someone still on their way in goes from where they next stop.
      const out = (friend: Friend) => Math.abs(friend.z - PATH_Z) + (EDGE[0] - friend.x)
      const next = staying.reduce((a, b) => (out(b) < out(a) ? b : a))
      if (next.pace === 0) {
        next.state = 'going'
        next.route = next.z === PATH_Z ? [EDGE] : [[next.x, PATH_Z], EDGE]
        this.gate = 1.8
      }
    }

    for (const friend of this.friends) {
      const haunt = HAUNTS[friend.haunt] ?? (HAUNTS[0] as (typeof HAUNTS)[number])
      const skin = FRIENDS[friend.haunt] ?? MOSS
      const carries = CARRIES[haunt.job]
      const life = this.clock + friend.haunt * 1.9
      if (friend.state !== 'busy') {
        const target = friend.route[0]
        if (target && walk(friend, target, STROLL, dt)) friend.route.shift()
        // They appear at the edge and are gone at it, out of scattered dots and back into them.
        const gone = friend.state === 'going' && friend.route.length === 0
        friend.grow = clamp(friend.grow + ((gone ? -1 : 1) * dt) / ARRIVES)
        if (friend.route.length === 0 && friend.state === 'coming') {
          friend.state = 'busy'
          friend.clock = 0
          friend.beat = 0
          friend.want = headingOf(haunt.face)
        }
        // What they use is carried at their side as they walk; arms that were up come down, and
        // are not dropped.
        const arm = reach(friend, carries.arm, dt)
        const empty = !carries.hold && Math.abs(arm) < 0.02
        figure(
          veiled(box, ease(friend.grow)),
          { ...walking(friend, STROLL), life },
          skin,
          empty ? {} : { hold: carries.hold, tool: arm, other: carries.hold ? undefined : arm },
        )
        continue
      }
      // They turn to what they have come for before they start on it.
      const ready = turn(friend, dt)
      const stance = standing(friend, life)
      if (ready) friend.clock += dt
      if (haunt.job === 'chop') {
        // Three unhurried blows at the trunk with an axe, and then a breather as long again.
        const each = 1.7
        const swings = 3
        const round = swings * each * 2
        const into = friend.clock % round
        const swinging = into < swings * each
        const through = (into % each) / each
        const landed =
          Math.floor(friend.clock / round) * swings +
          (swinging ? Math.floor(into / each) + (through >= LANDS ? 1 : 0) : swings)
        if (landed > friend.beat && dt > 0) chips([12.6, 1.8, 1.0], [-0.6, 0.2, 0.3], 2, 0.3)
        friend.beat = landed
        friend.arm = strikeArm(swinging ? blowOf(through * TURN) : 0)
        // Eyes on the trunk while the axe is going; a look about in the breather.
        figure(box, stance, skin, { hold: 'axe', tool: friend.arm, gaze: swinging ? 0 : undefined })
      } else if (haunt.job === 'fish') {
        // A rod held out over the water, a line down from its tip, and a float that rides the
        // swell. Now and then something takes it: the rod comes up a little, and goes back.
        const every = 11
        const into = friend.clock % every
        const tug = into < 1.1 ? Math.sin((into / 1.1) * Math.PI) : 0
        const bites = Math.floor(friend.clock / every)
        friend.arm = -1.0 - tug * 0.3
        const tip = figure(box, stance, skin, { hold: 'rod', tool: friend.arm, gaze: 0, nod: 0.12 })
        if (tip && ready) {
          if (bites > friend.beat && dt > 0) chips([tip[0] - 0.5, 0.5, tip[2] - 0.5], [0, 1.1, 0], 3, 0.2)
          const float = 0.92 + Math.sin(friend.clock * 1.7) * 0.04 - tug * 0.12
          box(
            tip[0] - 0.02,
            float,
            tip[2] - 0.02,
            0.04,
            Math.max(0.05, tip[1] - float),
            0.04,
            60,
            Kind.log,
            0,
            0,
          )
          cube(box, tip[0], float, tip[2], 0.2, 252, Kind.wool)
        }
        friend.beat = bites
      } else {
        // A block every few seconds: it is lifted in both hands, set on the tower, and the arms
        // come down empty. With the tower up there is nothing left to set: they look it over,
        // and now and then turn round to the pond.
        const every = 3.2
        const into = (friend.clock % every) / every
        const going = this.built < TOWER.length
        const raise = !going
          ? 0
          : into < 0.25
            ? ease(into / 0.25)
            : into < 0.45
              ? 1
              : into < 0.7
                ? 1 - ease((into - 0.45) / 0.25)
                : 0
        const set = Math.floor(friend.clock / every) + (into >= 0.3 ? 1 : 0)
        const next = TOWER[this.built]
        const holding = going && into < 0.3 && next
        if (set > friend.beat && going && dt > 0) {
          this.built += 1
          this.builtAt = this.clock
        }
        friend.beat = set
        if (!going) friend.want = headingOf(friend.clock % 13 > 9.5 ? [0, 1] : haunt.face)
        const arm = going ? -raise * 2.6 : reach(friend, 0, dt)
        friend.arm = arm
        figure(
          box,
          stance,
          skin,
          Math.abs(arm) > 0.02
            ? {
                tool: arm,
                other: arm,
                load: holding ? [next[4], next[3]] : undefined,
                heft: raise,
                gaze: 0,
                nod: -0.2 * raise,
              }
            : {},
        )
      }
    }
    this.friends = this.friends.filter(
      (friend) => !(friend.state === 'going' && friend.route.length === 0 && friend.grow <= 0),
    )
    this.tower(box, home)
    const ambling = this.graze(dt, box)
    // The fire is lit when someone comes in and dies down when the last has gone.
    const lit = wanted > 0 || this.friends.length > 0
    this.fire = clamp(this.fire + ((lit ? 1 : -1) * dt) / 1.5)
    if (this.fire > 0) this.smoke(box)
    return this.friends.length > 0 || ambling || (this.fire > 0 && this.fire < 1)
  }

  /** As much of the builder's tower as stands, whoever is or isn't about. Its newest block grows in. */
  private tower(box: Box, home: number): void {
    for (let n = 0; n < this.built && n < TOWER.length; n++) {
      const [x, y, z, kind, tone] = TOWER[n] as (typeof TOWER)[number]
      const fresh = n === this.built - 1 ? clamp((this.clock - this.builtAt) / 0.35) : 1
      const size = 0.55 + 0.45 * ease(fresh)
      const inset = (1 - size) / 2
      box(x + inset, y, z + inset, size, size, size, tone, kind, kind === Kind.lamp ? home : 0, 0)
    }
  }

  /**
   * The sheep: now and then a slow amble to the next corner of its own patch, and a long while
   * with its head down. True while either is walking or turning.
   */
  private graze(dt: number, box: Box): boolean {
    let ambling = false
    this.herd.forEach((one, index) => {
      const patch = PATCHES[index % PATCHES.length] as readonly Spot[]
      one.clock += dt
      if (one.rest > 0) one.rest -= dt
      else if (walk(one, patch[one.to % patch.length] as Spot, AMBLE, dt, 0.8)) {
        one.rest = 7 + hash3(index, one.to, 5) * 6
        one.to += 1
      } else ambling = true
      // Head down while it stands, up now and then to look about; it is lowered and raised, not flipped.
      const down = one.rest > 0 && Math.sin(one.clock * 0.45 + index * 2) > -0.35 ? 1 : 0
      one.head += clamp(down - one.head, -dt * 1.8, dt * 1.8)
      if (one.head > 0.001 && one.head < 0.999) ambling = true
      sheep(
        box,
        {
          x: one.x,
          y: 1,
          z: one.z,
          heading: one.heading,
          phase: one.phase,
          stride: strideOf(one, AMBLE),
          inside: 0,
        },
        ease(clamp(one.head)),
      )
    })
    return ambling
  }

  /**
   * Smoke from the chimney: a few puffs, each bigger and further off than the one behind it, and
   * each thinning to nothing at the top of its rise.
   */
  private smoke(box: Box): void {
    for (let n = 0; n < 4; n++) {
      const age = (this.clock / 4.6 + n / 4) % 1
      const size = (0.26 + age * 0.62) * puff(age)
      if (size > 0.02)
        cube(
          box,
          3.5 + age * 1.1,
          10.3 + age * 3.4,
          3.5 - age * 0.5,
          size,
          252,
          Kind.wool,
          0,
          0,
          ease(this.fire),
        )
    }
  }

  /**
   * The small scene a way to play puts on the grass. When another is asked for, the new one comes
   * in out of scattered dots while the one that was on thins away into them, the two crossing;
   * and each starts in the middle of things, so what it is can be seen at once. With `still`, it
   * is one moment of the scene and nothing moves. True while it should be drawn on every frame
   * and not only on the slow loop's ticks.
   */
  playStep(play: Play, dt: number, box: Box, chips: Chips, home: number, still: boolean): boolean {
    this.torch = null
    const step = still ? 0 : dt
    if (this.scene && this.scene.play !== play) {
      // Whoever was on is seen out: their scene goes on playing as it thins, so nobody is halted
      // in mid-stride.
      // With nothing moving (less motion asked for, the page held, the grass too far off to make
      // anyone out) there is no dissolve to watch: the next is simply on.
      this.last = step === 0 ? null : this.scene
      this.scene = null
    }
    if (!this.scene) {
      this.scene = this.opening(play, still)
      if (step === 0) this.scene.age = CHANGES
    }
    this.clock += step
    this.tower(box, home)
    const last = this.last
    if (last) {
      last.leaving += step
      if (still || last.leaving >= CHANGES) this.last = null
      else this.play(last, step, box, chips)
    }
    // Only the scene that is on has a torch to light the grass by.
    this.torch = null
    const scene = this.scene
    scene.age = still ? CHANGES : scene.age + step
    scene.still = still
    this.play(scene, step, box, chips)
    return !still
  }

  /** One scene, a step on, drawn through a veil: so everything of it comes and goes together. */
  private play(scene: Scene, step: number, box: Box, chips: Chips): void {
    scene.clock += step
    const seen = veiled(box, scene.still ? 1 : thereOf(scene))
    if (scene.play === 'creative') this.creative(scene, step, seen)
    else if (scene.play === 'create') this.contraption(scene, step, seen)
    else if (scene.play === 'smooth') this.company(scene, step, seen)
    else this.vigil(scene, step, seen, chips)
  }

  /** A scene as it stands when it is first seen: already under way. */
  private opening(play: Play, still: boolean): Scene {
    const scene: Scene = {
      play,
      clock: 0,
      hero: null,
      mobs: [],
      strollers: [],
      idler: null,
      hover: SITE[1] + 2.4,
      rise: 0,
      reach: 1,
      age: 0,
      leaving: 0,
      still: false,
    }
    if (play === 'survival' || play === 'hardcore') {
      // Someone with a torch, standing their ground, and the dead already on their way. (As one
      // held moment, both of hardcore's are up, or it would look the same as survival.)
      scene.hero = { ...bodyAt(STAND, [-1, 0]), state: 'stand', t: 0, aim: 0, struck: false }
      const graves = play === 'hardcore' ? GRAVES : GRAVES.slice(0, 1)
      scene.mobs = graves.map((grave, index) =>
        index === 0
          ? { ...bodyAt([grave.from[0] + 0.9, grave.from[1]], [1, 0]), state: 'coming' as const, t: 0 }
          : still
            ? { ...bodyAt([grave.from[0], grave.from[1] + 0.9], [0, 1]), state: 'coming' as const, t: 0 }
            : { ...bodyAt(grave.from, [0, 1]), state: 'down' as const, t: -0.4 },
      )
    } else if (play === 'smooth') {
      // More people, and room for all of them: each on a line of their own, four blocks apart.
      const line = (
        ends: readonly [Spot, Spot],
        at: Spot,
        toward: 0 | 1,
        hold: number,
        rests: number,
      ): Stroller => ({
        ...bodyAt(at, [ends[toward][0] - at[0], ends[toward][1] - at[1]]),
        ends,
        toward,
        hold,
        rests,
        cruise: STROLL * 0.8,
      })
      scene.strollers = [
        line(
          [
            [2.8, 9.6],
            [7.2, 9.6],
          ],
          [4.6, 9.6],
          1,
          0,
          7.5,
        ),
        line(
          [
            [3.6, 14.0],
            [7.6, 14.0],
          ],
          [7.6, 14.0],
          0,
          4.5,
          9,
        ),
      ]
      scene.idler = bodyAt([12.6, 9.5], [0, 1])
    } else if (play === 'creative') {
      // Part-way into the first thing built; or, as one held moment, the thing finished.
      scene.clock = still ? (SHAPES[0] as readonly Cell[]).length / SETS + 1 : 2.6
    } else scene.idler = bodyAt([4.6, 12.6], [1, 0])
    return scene
  }

  /**
   * Survival, and hardcore the same with less light and more of them: someone with a torch
   * stands their ground, the dead come up at the meadow's edge and shamble in, each is met with
   * one blow, and then it is quiet for a while.
   */
  private vigil(scene: Scene, dt: number, box: Box, chips: Chips): void {
    const hero = scene.hero
    if (!hero) return
    const hard = scene.play === 'hardcore'
    const pace = hard ? SHAMBLE * 1.25 : SHAMBLE
    const life = scene.still ? undefined : scene.clock
    hero.t += dt
    scene.mobs.forEach((mob, index) => {
      const grave = GRAVES[index] as (typeof GRAVES)[number]
      mob.t += dt
      if (mob.state === 'down') {
        // It comes up again once whoever it is after is on the way back to meet it.
        if (mob.t >= 0 && (hero.state === 'out' || hero.state === 'stand' || hero.state === 'strike')) {
          mob.state = 'rising'
          mob.t = 0
          mob.x = grave.from[0]
          mob.z = grave.from[1]
          mob.want = headingOf([grave.stop[0] - grave.from[0], grave.stop[1] - grave.from[1]])
          mob.heading = mob.want
        }
      } else if (mob.state === 'rising') {
        if (mob.t >= 0.9) mob.state = 'coming'
      } else if (mob.state === 'coming') {
        if (walk(mob, grave.stop, pace, dt, 1.1)) {
          mob.state = 'waiting'
          mob.t = 0
        }
      } else if (mob.state === 'falling' && mob.t >= ARRIVES) {
        // Down for good, until whoever put it there has been away and come back.
        mob.state = 'down'
        mob.t = Number.NEGATIVE_INFINITY
      }
      const risen =
        mob.state === 'rising'
          ? ease(clamp(mob.t / 0.9))
          : mob.state === 'falling'
            ? 1 - ease(clamp(mob.t / ARRIVES))
            : 1
      if (mob.state !== 'down') {
        // Arms out in front, the way the dead hold them, rocking a little as they come.
        const rock = Math.sin(mob.phase) * 0.07
        figure(box, { ...walking(mob, pace), grow: risen }, DEAD, {
          tool: -1.5 + rock,
          other: -1.5 - rock,
          gaze: 0,
        })
      }
    })

    const up = (mob: Mob) => mob.state === 'rising' || mob.state === 'coming' || mob.state === 'waiting'
    if (hero.state === 'stand') {
      // Faced toward whichever of them is coming, and waiting until it is near.
      const next = scene.mobs.findIndex(up)
      if (next < 0) {
        if (scene.mobs.every((mob) => mob.state === 'down' && mob.t === Number.NEGATIVE_INFINITY)) {
          hero.state = 'after'
          hero.t = 0
        }
      } else {
        const mob = scene.mobs[next] as Mob
        hero.aim = next
        hero.want = headingOf([mob.x - hero.x, mob.z - hero.z])
        const facing = turn(hero, dt)
        // It is met as it arrives: nobody stands with the dead at arm's length.
        if (facing && mob.state === 'waiting' && mob.t > 0.15) {
          hero.state = 'strike'
          hero.t = 0
          hero.struck = false
        }
      }
    } else if (hero.state === 'strike') {
      const mob = scene.mobs[hero.aim]
      if (!hero.struck && hero.t >= BLOW * LANDS && mob) {
        hero.struck = true
        mob.state = 'falling'
        mob.t = 0
        // Small chips, low down: it goes back into the ground, it doesn't come apart.
        chips([mob.x - 0.5, 0.9, mob.z - 0.5], [(mob.x - hero.x) * 0.4, 0.5, (mob.z - hero.z) * 0.4], 4, 0.18)
      }
      if (hero.t >= BLOW) {
        hero.state = 'stand'
        hero.t = 0
      }
    } else if (hero.state === 'after') {
      if (hero.t >= 1.6) hero.state = 'back'
    } else if (hero.state === 'back') {
      if (walk(hero, POST, STROLL * 0.85, dt)) {
        hero.state = 'rest'
        hero.t = 0
      }
    } else if (hero.state === 'rest') {
      // A look back the way they came, half-way through the wait.
      if (hero.t > 1.4) hero.want = headingOf([-1, 0])
      turn(hero, dt)
      if (hero.t >= 3.4) {
        hero.state = 'out'
        scene.mobs.forEach((mob, index) => {
          mob.t = -index * 1.8
        })
      }
    } else if (walk(hero, STAND, STROLL * 0.85, dt)) {
      hero.state = 'stand'
      hero.t = 0
    }
    // A torch is held up in one hand, which is how a person is told from the dead by so little
    // light; it lights the grass round whoever carries it, and it is what the dead are met with.
    // The blow is made with the torch arm: drawn up and back, brought down past where it was
    // held, and back up to it.
    let arm = -1.3
    if (hero.state === 'strike') {
      const through = hero.t / BLOW
      const follow = through > LANDS ? Math.sin(((through - LANDS) / (1 - LANDS)) * Math.PI) * 0.45 : 0
      arm = -1.3 - 1.2 * blowOf(through * TURN) + follow
    }
    const tip = figure(box, { ...walking(hero, STROLL * 0.85), life }, hard ? NOOR : MOSS, {
      hold: 'torch',
      glow: LIT,
      tool: arm,
      gaze: 0,
    })
    this.torch = thereOf(scene) > 0.5 ? (tip ?? [hero.x, 2.3, hero.z]) : null
  }

  /**
   * The smoother kind: the same game with more people in it, and room for all of them. Two walk a
   * line each, one by the house and one along the front, one at a time and with a long stop at
   * either end, and a third stands at the pond. It is day, so the dead are not about.
   */
  private company(scene: Scene, dt: number, box: Box): void {
    const life = scene.still ? undefined : scene.clock
    scene.strollers.forEach((one, index) => {
      // One sets off at a time, and a moment after the other has stopped: two pacing at once is a
      // pair of sentries, and one starting as the other stops is a relay.
      if (one.pace === 0 && scene.strollers.some((other) => other !== one && other.pace > 0))
        one.hold = Math.max(one.hold, 1.4)
      if (one.hold > 0) {
        one.hold -= dt
        // Half-way through the stop they turn to face the way they will go.
        const next = one.ends[one.toward]
        if (one.hold < one.rests * 0.5) one.want = headingOf([next[0] - one.x, next[1] - one.z])
        turn(one, dt)
      } else if (walk(one, one.ends[one.toward], one.cruise, dt)) {
        one.toward = one.toward === 0 ? 1 : 0
        one.hold = one.rests
      }
      figure(
        box,
        { ...walking(one, one.cruise), life: life === undefined ? undefined : life + index * 2.3 },
        index === 0 ? MOSS : KAI,
      )
    })
    // At the pond, looking at the water, and now and then round at the others.
    const idler = scene.idler
    if (idler) {
      idler.want = headingOf(scene.clock % 17 > 13.5 ? [-1, 0] : [0, 1])
      turn(idler, dt)
      figure(box, standing(idler, life === undefined ? undefined : life + 5), NOOR)
    }
  }

  /** Creative: something built out of nothing, a block at a time, by someone who can fly. */
  private creative(scene: Scene, dt: number, box: Box): void {
    let left = scene.clock
    let which = 0
    // Which shape, and how far into its turn: each takes as long as it has blocks.
    for (;;) {
      const count = (SHAPES[which % SHAPES.length] as (typeof SHAPES)[number]).length
      const takes = count / SETS + STANDS + CLEARS
      if (left < takes) break
      left -= takes
      which += 1
    }
    const shape = SHAPES[which % SHAPES.length] as (typeof SHAPES)[number]
    const building = shape.length / SETS
    const placed = left < building ? left * SETS : shape.length
    // When it has stood a while it is taken away as one thing, every block of it thinning into
    // dots together: it is not picked apart a block a frame.
    const going = left > building + STANDS ? clamp((left - building - STANDS) / CLEARS) : 0
    const whole = 1 - ease(going)
    const shown = Math.min(shape.length, Math.ceil(placed))
    for (let n = 0; n < shown; n++) {
      const [x, y, z, gold] = shape[n] as Cell
      // A block arrives out of a few dots, a little small, and fills and grows into place.
      // Courses alternate, pale and stone, and the last block is the gold one.
      const arrived = clamp(placed - n)
      const size = 0.7 + 0.3 * ease(arrived)
      const solid = ease(clamp(arrived * 1.4)) * whole
      if (solid < 0.02) continue
      const stone = y % 2 === 0
      cube(
        box,
        SITE[0] + x + 0.5,
        SITE[1] + y + 0.5,
        SITE[2] + z + 0.5,
        size,
        gold ? 80 : stone ? 150 : 250,
        gold ? Kind.lamp : stone ? Kind.cobble : Kind.wool,
        gold ? LIT : 0,
        0,
        solid,
      )
    }
    // The builder hovers behind it and above, as only creative lets you, an arm held out to the
    // work and eyes down on it, and rises with it as it grows and comes down as it goes, never
    // faster than a stroll. They keep their place: the blocks come, not the builder.
    const top = shown > 0 && going < 0.5 ? (shape[shown - 1] as Cell)[1] : 0
    const height = SITE[1] + 2.4 + Math.min(top, 8) * 0.6
    // Its rising gathers and sheds pace like a walk does; as one held moment, it is simply there.
    const rise = clamp((height - scene.hover) * 1.6, -HOVERS, HOVERS)
    scene.rise += clamp(rise - scene.rise, (-HOVERS / EASE) * dt, (HOVERS / EASE) * dt)
    scene.hover = scene.still ? height : scene.hover + scene.rise * dt
    // The arm comes out to the work and goes back to the side; it is never one and then the other.
    scene.reach += clamp((left < building ? 1 : 0) - scene.reach, -dt * 2.5, dt * 2.5)
    figure(
      box,
      {
        x: HOVER[0],
        y: scene.hover + Math.sin(scene.clock * 1.3) * 0.06,
        z: HOVER[1],
        heading: 0,
        phase: 0,
        stride: 0,
        inside: 0,
      },
      KAI,
      { tool: -1.2 * ease(scene.reach), gaze: 0, nod: 0.3 },
    )
  }

  /**
   * The Create mod: a water wheel standing in the pond, a hammer it works on the bank, and what
   * they make carried off across the yard. The wheel stands across the pond's diagonal, so it is
   * seen nearly face on from where the camera is.
   */
  private contraption(scene: Scene, dt: number, box: Box): void {
    const clock = scene.clock
    const spun = clock * 0.45
    // In the middle of the pond, so its paddles come down into water at both ends of their swing.
    const cx = 12
    const cy = 3.0
    const cz = 12.5
    // The wheel stands across the pond's diagonal, turning on an axle that points at the camera:
    // every timber of it is a plank turned to its place on the wheel, not a cloud of blocks.
    const round = -0.694
    const sinR = Math.sin(round)
    const cosR = Math.cos(round)
    /** One timber: how far out from the axle its middle is, where round the wheel, and its size. */
    const timber = (
      out: number,
      angle: number,
      across: number,
      radial: number,
      along: number,
      tone: number,
      kind: number,
    ) => {
      const y = out * Math.cos(angle)
      const z = out * Math.sin(angle)
      box(
        cx + z * sinR - across / 2,
        cy + y - radial / 2,
        cz + z * cosR - along / 2,
        across,
        radial,
        along,
        tone,
        kind,
        0,
        0,
        round,
        angle,
      )
    }
    // A rim of twelve planks, eight paddles that reach into the water, and four spokes to a hub.
    for (let n = 0; n < 12; n++) timber(2.7, spun + (n / 12) * TURN, 0.5, 0.3, 1.5, 250, Kind.planks)
    for (let n = 0; n < 8; n++) timber(3.1, spun + (n / 8) * TURN, 0.9, 0.62, 0.14, 235, Kind.planks)
    for (let n = 0; n < 4; n++) timber(1.4, spun + (n / 4) * TURN, 0.2, 2.0, 0.22, 90, Kind.log)
    timber(0, spun, 0.7, 0.7, 0.7, 90, Kind.log)
    // The hammer on the bank: lifted slowly by the wheel, and let fall.
    const beat = (clock * 0.42) % 1
    const up = beat < 0.75 ? ease(beat / 0.75) : 1 - ease((beat - 0.75) / 0.25)
    box(6.6, 1, 12.6, 1, 1, 1, 150, Kind.cobble, 0, 0)
    box(6.6, 2.1 + up * 1.3, 12.6, 1, 1, 1, 235, Kind.iron, 0, 0)
    box(7.86, 1.9, 12.96, 0.28, 2.2, 0.28, 90, Kind.log, 0, 0)
    // What it makes goes off across the yard, one after another, round the lamp post to a chest
    // by the door. Each comes off the hammer out of a few dots and is gone into the chest the
    // same way.
    const belt: readonly Spot[] = [
      [7.6, 11.0],
      [8.6, 9.3],
      [10.3, 8.2],
      [10.8, 6.4],
    ]
    const legs = belt.length - 1
    for (let n = 0; n < 3; n++) {
      const through = (clock * 0.14 + n / 3) % 1
      const along = through * legs
      const leg = Math.min(legs - 1, Math.floor(along))
      const a = belt[leg] as Spot
      const b = belt[leg + 1] as Spot
      const t = along - leg
      cube(
        box,
        a[0] + (b[0] - a[0]) * t,
        1.25,
        a[1] + (b[1] - a[1]) * t,
        0.46,
        250,
        Kind.iron,
        0,
        0,
        puff(through),
      )
    }
    box(10.3, 1, 5.6, 1, 1, 1, 128, Kind.chest, 0, 0)
    // Whoever built it stands back and watches the hammer go up and come down.
    const idler = scene.idler
    if (idler) {
      turn(idler, dt)
      figure(box, standing(idler, undefined), NOOR, { gaze: 0, nod: -0.35 * up })
    }
  }

  /**
   * Whoever typed the address, while the server is still asleep: one friend with a torch, who
   * comes in at the end of the path, walks a little way up it toward the dark house, stops, and
   * lifts the torch to look for a light in a window, looking about. There while `there`, thinned
   * in and out at the chunk's edge like anyone arriving. The torch lights the grass round them.
   */
  callerStep(there: boolean, dt: number, box: Box, still: boolean): void {
    if (there && !this.caller)
      this.caller = { ...bodyAt(still ? CALLS : EDGE, [-1, 0]), grow: still ? 1 : 0, stood: 0 }
    const caller = this.caller
    if (!caller) return
    caller.grow = still ? (there ? 1 : 0) : clamp(caller.grow + ((there ? 1 : -1) * dt) / ARRIVES)
    if (!there && caller.grow <= 0) {
      this.caller = null
      return
    }
    const arrived = walk(caller, CALLS, STROLL, dt)
    if (arrived) caller.stood += dt
    // Stood, the torch goes up toward the house and comes down again, slowly, over and over.
    const lifted = arrived ? 0.5 - 0.5 * Math.cos(caller.stood * 1.5) : 0
    const life = still ? undefined : this.clock
    const tip = figure(
      veiled(box, ease(caller.grow)),
      arrived ? standing(caller, life) : { ...walking(caller, STROLL), life },
      MOSS,
      // Left to itself the head looks about; it tips up with the torch.
      {
        hold: 'torch',
        glow: LIT,
        tool: -1.3 - 0.7 * lifted,
        gaze: arrived ? undefined : 0,
        nod: -0.25 * lifted,
      },
    )
    if (caller.grow > 0.5) this.torch = tip ?? [caller.x, 2.3, caller.z]
  }

  /** The warm light the room last played asked for, in front of whatever lamps are lit in it. */
  get lamp(): Light | null {
    return this.rooms.lit
  }

  /**
   * The room the page has reached, playing its scene (engine/scenes): the server in it, the worker
   * who minds it, and whatever else moves there. `showing` is what the section's demonstration
   * says it is showing. With `still`, one moment of it.
   */
  roomStep(room: RoomKey, dt: number, box: Box, chips: Chips, still: boolean, showing?: Showing): void {
    this.rooms.step(room, dt, box, chips, still, showing)
  }

  /**
   * The server, in the vault under the house: one machine built out of the game's own parts, for
   * the server the visitor chose. It is not a diagram of the real one; it is the idea of it.
   *
   * A rack of trays with small lamps on their faces, one tray more the more memory the group is
   * given; a furnace for a core, and a second for a big group; chests for its disk; redstone on
   * the floor between them, with something always travelling along it; and over the rack, turning,
   * the world it runs, which is a different small world for each way to play.
   *
   * It grows and shrinks as the answers change, and it does so as a machine does, not as a chart:
   * a bay comes up out of the rack, a tray pops out in front of it, is pushed home a little too
   * far and settles, throws a spark, and its lamps come on one after another. A chest is dropped
   * onto the stack, bounces, and its lid jumps. A furnace lands and its fire flares. The small
   * world on top is bumped by all of it and rides it out on a spring; changed for another, it
   * spins up, is gone, and the new one pops out of where it was. Nothing fades.
   *
   * `ledger` says, a pair of letters a line, which group each line is in (g, m, a or u) and
   * whether the last choice changed it (2). A part whose lines changed is lit: the plate under
   * the world for the game, the trays' lamps for the machine, the chests' latches for the upkeep.
   */
  cellar(ledger: string, play: Play, party: Party, dt: number, box: Box, still: boolean): void {
    const hot = (group: string) => {
      for (let n = 0; n + 1 < ledger.length; n += 2)
        if (ledger[n] === group && ledger[n + 1] === '2') return true
      return false
    }
    const want = {
      trays: party === '5' ? 3 : party === '10' ? 4 : 5,
      chests: party !== '5' || play === 'create' ? 5 : 3,
      cores: party === '20' || party === 'more' ? 2 : 1,
    }
    const FLOOR = -8
    // How far forward of the vault's middle it all stands: near its open wall, where it is seen
    // whole, and facing out of it.
    const X = 2
    const facing = (x: number, y: number, z: number, scale = 1): Place => ({
      x: X + x,
      y,
      z,
      heading: Math.PI / 2,
      inside: CELLAR,
      scale,
    })
    if (!this.rig || still)
      this.rig = {
        rack: new Rack(want.trays),
        chests: slotsOf(want.chests, 5),
        cores: slotsOf(want.cores, 2),
        play,
        was: null,
        swapped: SETTLED,
        spin: 0.6,
        whirl: 0.4,
        ride: FLOOR + want.trays * UNIT + 0.95,
        bob: 0,
        clock: still ? 2 : (this.rig?.clock ?? 0),
      }
    const rig = this.rig
    const step = still ? 0 : dt
    rig.clock += step
    const clock = rig.clock
    rig.rack.size(want.trays, clock)
    sequence(rig.chests, want.chests, clock, 0.2)
    sequence(rig.cores, want.cores, clock, 0.3)
    if (play !== rig.play) {
      // The small world is changed with a flourish: it is spun up and hops, and the other pops
      // out of where it was.
      rig.was = rig.play
      rig.play = play
      rig.swapped = clock
      rig.whirl += 11
      rig.bob += 2.4
    }

    // The rack, its lamps all lit when the last choice was about the machine.
    const top = rig.rack.draw(box, facing(9.95, FLOOR, 4), clock, hot('m'))

    // The world it runs, over the rack: a block of ground, turning, with what the way to play
    // puts on it. It rides on a spring, so whatever the rack does under it, it feels. A plate
    // under it is lit when the last choice was about the game.
    const game = hot('g')
    box(
      X + 8.55,
      top,
      3.55,
      0.9,
      0.1,
      0.9,
      game ? 80 : 150,
      game ? Kind.lamp : Kind.iron,
      game ? LIT : 0,
      CELLAR,
    )
    const rest = top + 0.95
    if (still) rig.ride = rest
    for (let left = step; left > 0; left -= 1 / 60) {
      const tick = Math.min(left, 1 / 60)
      rig.bob += ((rest - rig.ride) * 70 - rig.bob * 7) * tick
      rig.ride += rig.bob * tick
      rig.whirl += (0.4 - rig.whirl) * (1 - Math.exp(-tick * 3.2))
      rig.spin += rig.whirl * tick
    }
    const small = (which: Play, scale: number) =>
      smallWorld(
        box,
        { x: X + 9, y: rig.ride - 0.36, z: 4, heading: rig.spin, inside: CELLAR, scale },
        which,
        clock,
      )
    const since = clock - rig.swapped
    if (rig.was && since < 0.22) small(rig.was, 1 - windup(since / 0.22))
    else small(rig.play, rig.was ? overshoot(clamp((since - 0.22) / 0.3)) : 1)

    // Its disk: chests, dropped onto the stack. Each lands, bounces, and its lid jumps. A latch
    // on each is lit when the last choice was about its upkeep.
    const kept = hot('u')
    rig.chests.forEach((slot, n) => {
      const age = clock - slot.at
      if (!slot.on && age > 0.42) return
      const landed = slot.on
        ? drop(age, 1.9)
        : { up: 0.5 * Math.sin(Math.PI * clamp(age / 0.4)), jolt: clamp(age / 0.12) }
      const scale = slot.on ? overshoot(clamp(age / 0.14)) : 1 - windup(clamp((age - 0.16) / 0.24))
      const y = FLOOR + (n < 3 ? n : n - 3) * 0.9 + landed.up
      chest(box, facing(11.2, y, (n < 3 ? 1.12 : 2.08) + 0.45, scale), landed.jolt, kept)
    })

    // A furnace for each core, one on the other, with a fire in its mouth. A new one is dropped
    // on, its fire flares, and a puff of smoke goes up.
    rig.cores.forEach((slot, n) => {
      const age = clock - slot.at
      if (!slot.on && age > 0.5) return
      const scale = slot.on ? overshoot(clamp(age / 0.14)) : 1 - windup(clamp((age - 0.22) / 0.26))
      const y = FLOOR + n + (slot.on ? drop(age, 1.7).up : 0)
      const flare = slot.on && age > 0.36 ? Math.exp(-(age - 0.36) * 5) : 0
      furnace(box, facing(11.2, y, 6, scale), slot.on ? 1 + flare : 1 - clamp(age / 0.2), clock, n)
      const smoke = age - 0.36
      if (slot.on && smoke > 0 && smoke < 1)
        for (let puffed = 0; puffed < 3; puffed++) {
          const rise = clamp(smoke - puffed * 0.12)
          const size = (0.2 + rise * 0.3) * puff(rise)
          if (size > 0.02)
            cube(
              box,
              X + 10.7 + puffed * 0.12,
              y + 1.15 + rise * 0.9,
              6 - puffed * 0.1,
              size,
              250,
              Kind.wool,
              0,
              CELLAR,
            )
        }
    })

    // Redstone on the floor from the furnace and the chests to the rack, and something always on
    // its way along it: from the fire to the trays, and from the trays to the chests.
    wire(box, X + 11.27, 6, X + 11.6, 6, FLOOR, CELLAR)
    wire(box, X + 11.6, 2.07, X + 11.6, 6, FLOOR, CELLAR)
    wire(box, X + 10.27, 4, X + 11.6, 4, FLOOR, CELLAR)
    wire(box, X + 11.27, 2.07, X + 11.6, 2.07, FLOOR, CELLAR)
    pulse(
      box,
      [
        [X + 11.3, 6],
        [X + 11.6, 6],
        [X + 11.6, 4],
        [X + 10.25, 4],
      ],
      (clock / 3.4) % 1,
      FLOOR,
      CELLAR,
    )
    pulse(
      box,
      [
        [X + 10.25, 4],
        [X + 11.6, 4],
        [X + 11.6, 2.07],
        [X + 11.3, 2.07],
      ],
      (clock / 4.6 + 0.5) % 1,
      FLOOR,
      CELLAR,
    )
    // The fire and the lamps light the floor in front of it.
    this.glow = [X + 11.6, FLOOR + 1.6, 4, 5.5]
  }
}

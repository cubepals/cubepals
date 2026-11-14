// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Who moves on the chunk's grass, and what they are doing there.
 *
 * There are few of them, and each has room. Friends who join walk in along the path, go to a place
 * of their own and get on with something unhurried: one fells the tree, one builds, one fishes.
 * When they leave they walk back out the way they came. A couple of sheep graze, and the chimney
 * smokes while anyone is in.
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
 * of the world's grid, so none of it needs the world packed again.
 */
import { clamp, ease } from './curves'
import {
  type Box,
  blowOf,
  cube,
  figure,
  fishingLine,
  KAI,
  MOSS,
  NOOR,
  type Skin,
  sheep,
  strikeArm,
  veiled,
} from './models'
import { Pasture } from './pasture'
import { type Body, bodyAt, headingOf, reach, type Spot, STROLL, strideOf, turn, walk } from './walk'
import { hash3, Kind } from './world'

/** Throws a few chips from a place, mostly the way `out` points. */
export type Chips = (
  at: readonly [number, number, number],
  out: readonly [number, number, number],
  count: number,
  /** How big each chip is, in blocks: a block's own chips, unless said. */
  size?: number,
) => void

const TURN = Math.PI * 2

/** How fast a sheep goes, in blocks a second. */
const AMBLE = 0.45
/** How long someone takes to appear at the chunk's edge, and to go. */
const ARRIVES = 0.5
/** How far into a blow of the axe it lands. */
const LANDS = 0.64

/** How big a puff of smoke is over its life, 0 to 1: it swells, holds, and thins to nothing. */
const puff = (age: number) => ease(clamp(age / 0.12)) * (1 - ease(clamp((age - 0.75) / 0.25)))

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
}

/** What each friend carries to their work, and where the arm that carries it is held. */
const CARRIES = {
  chop: { hold: 'axe', arm: strikeArm(0) },
  fish: { hold: 'rod', arm: -1.0 },
  build: { hold: undefined, arm: 0 },
} as const

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
  private herd: Grazer[] = PATCHES.map((patch, index) => ({
    ...bodyAt(patch[0] as Spot, index === 0 ? [1, 0] : [0, -1]),
    to: 1,
    rest: 3 + index * 2.5,
  }))
  /** The grass the sheep stop at, and how each eats from it. */
  private readonly pasture = new Pasture(PATCHES)
  private clock = 0

  /** True while any friend is on the grass, on their way in or out as well as at their place. */
  get about(): boolean {
    return this.friends.length > 0
  }

  /** How many friends are on the server: everyone on the grass but those on their way out. */
  get present(): number {
    return this.friends.filter((friend) => friend.state !== 'going').length
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
        const tip = figure(box, standing(friend, undefined), FRIENDS[friend.haunt] ?? MOSS, {
          hold: carries.hold,
          tool: carries.arm,
          gaze: 0,
        })
        // A rod still has its line in the water, and the float lies still on it.
        if (carries.hold === 'rod') fishingLine(box, tip, 0)
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
          fishingLine(box, tip, Math.sin(friend.clock * 1.7) * 0.04 - tug * 0.12)
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
   * The sheep: now and then a slow amble to the next corner of its own patch, a long while stood
   * there, and a mouthful of its grass (engine/pasture.ts). True while any of it is moving.
   */
  private graze(dt: number, box: Box): boolean {
    let ambling = false
    this.pasture.draw(dt, box)
    this.herd.forEach((one, index) => {
      const patch = PATCHES[index % PATCHES.length] as readonly Spot[]
      const down = this.pasture.head(index, one.rest > 0 ? (one.to - 1) % patch.length : -1, dt)
      // It finishes a mouthful before it sets off.
      if (one.rest > 0 || this.pasture.eating) one.rest -= dt
      else if (walk(one, patch[one.to % patch.length] as Spot, AMBLE, dt, 0.8)) {
        one.rest = 9 + hash3(index, one.to, 5) * 6
        one.to += 1
      } else ambling = true
      if (this.pasture.eating) ambling = true
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
        down,
        this.pasture.shake,
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
          8.3 + age * 3.4,
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
}

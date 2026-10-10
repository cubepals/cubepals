// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What goes on in the rooms under the grass. Every room is about the same thing, a server
 * (engine/server.ts), and each shows the one thing its section says about it: it is woken at the
 * gate, it sleeps, it is built, fitted with mods, copied, sent to a cloud, kept by the hundred.
 * One worker, in pale overalls with a lamp on the helmet, builds and minds them. It is the page's
 * whole argument as a character: somebody does all of this, and it isn't you.
 *
 * A scene follows its section's demonstration, which says what it is showing in a few plain
 * values (stage.ts, `show`); with nothing said, it plays a loop of its own. It is written in the
 * room's own terms (`u` along the open wall, `v` in from the back wall toward it, `h` up from
 * the floor), so the same scene would stand in any room.
 */
import { groupOf, LIT, type RoomKey, roomPlace } from './chunk'
import { clamp, lerp, wrap } from './curves'
import { type Box, figure, type Pose, type Skin, type Stance, WORKER } from './models'
import { type Place, pulse, smallWorld, spark, wire } from './server'
import { type Body, bodyAt, headingOf, routeTo, type Spot, strideOf, walk } from './walk'

/** Throws a few chips from a place, mostly the way `out` points. */
export type Chips = (
  at: readonly [number, number, number],
  out: readonly [number, number, number],
  count: number,
  size?: number,
) => void

/** What a room's demonstration says it is showing: a few named numbers, words or switches. */
export type Showing = Readonly<Record<string, string | number | boolean>>

/** How fast the worker walks, in blocks a second: a little under a stroll. */
export const ROUND = 1.2

/** A room as its scene sees it this frame. */
export interface View {
  room: RoomKey
  /** The room's light switch: what stands in the room is lit by it. */
  inside: number
  /** Seconds the scene has been playing, and how many of them this frame is. */
  clock: number
  dt: number
  /** One held moment, for someone who asked for less motion: nothing moves. */
  still: boolean
  box: Box
  chips: Chips
  showing: Showing | undefined
  /** A place in the room as a place in the world. */
  at(u: number, v: number, h?: number): [number, number, number]
  /**
   * Where a piece of the kit stands: the middle of its front edge at `u`, `v`, `h`, its face
   * looking `heading` round in the room's terms (0 toward the open wall, a quarter turn along `u`).
   */
  place(u: number, v: number, h?: number, heading?: number, scale?: number): Place
  /** A heading in the room's terms as one in the world's. */
  facing(heading: number): number
  /**
   * Which way round the room is: 1 where a turn toward `u` from the open wall is a turn the
   * world's way, −1 where it is the other. A head turned by `handed` looks along `u`; a piece
   * facing the open wall has its own side along `u` where it is 1, and against it where −1.
   */
  handed: number
  /** Somebody in the room as a figure to draw. */
  stance(body: Body, cruise: number, life?: number): Stance
  /**
   * The warm light on the floor in front of lamps that are lit: where its middle is, how far it
   * reaches and how bright it is, 0 to 1. A room has one, and it is there only while it is asked
   * for; it grows with the lamps that are on and goes with the last of them.
   */
  light(u: number, v: number, h: number, radius: number, level: number): void
}

/** The one loose light a room's scene asked for this frame: where, how far, how bright, whose. */
export type Light = [number, number, number, number, number, number]

function viewOf(
  room: RoomKey,
  clock: number,
  dt: number,
  still: boolean,
  box: Box,
  chips: Chips,
  showing: Showing | undefined,
  light: (lit: Light) => void = () => {},
): View {
  const inside = groupOf(room)
  const at = (u: number, v: number, h = 0) => roomPlace(room, u, v, h)
  const origin = at(0, 0)
  const facing = (heading: number): number => {
    const to = at(Math.sin(heading), Math.cos(heading))
    return headingOf([to[0] - origin[0], to[2] - origin[2]])
  }
  const handed = Math.sin(facing(Math.PI / 2) - facing(0)) < 0 ? -1 : 1
  return {
    room,
    inside,
    handed,
    clock,
    dt,
    still,
    box,
    chips,
    showing,
    at,
    facing,
    light(u, v, h, radius, level) {
      if (level > 0.02) light([...at(u, v, h), radius, Math.min(1, level), inside])
    },
    place(u, v, h = 0, heading = 0, scale = 1) {
      const [x, y, z] = at(u, v, h)
      return { x, y, z, heading: facing(heading), inside, scale }
    },
    stance(body, cruise, life) {
      const [x, y, z] = at(body.x, body.z)
      return {
        x,
        y,
        z,
        heading: facing(body.heading),
        phase: body.phase,
        stride: strideOf(body, cruise),
        inside,
        life,
      }
    },
  }
}

/** Somebody who is sent about a room: where they are, and the way they have left to go. */
export interface Hand extends Body {
  route: Spot[]
}

export const handAt = (spot: Spot, face: Spot): Hand => ({ ...bodyAt(spot, face), route: [] })

/** Sends someone to a place, along the room's axes: `first` is which they walk first. */
export function send(hand: Hand, to: Spot, first: 'x' | 'z' = 'x'): void {
  hand.route = routeTo([hand.x, hand.z], to, first)
}

/** Walks someone along the way they were sent. True once they are there and standing. */
export function tread(hand: Hand, cruise: number, dt: number): boolean {
  const next = hand.route[0]
  if (!next) return true
  if (walk(hand, next, cruise, dt)) hand.route.shift()
  return hand.route.length === 0
}

/** The worker, drawn: overalls, and a lamp on the helmet that is always lit. */
export function worker(view: View, hand: Body, pose: Pose = {}, look: Skin = WORKER): void {
  figure(
    view.box,
    view.stance(hand, ROUND, view.still ? undefined : view.clock),
    look === WORKER ? { ...WORKER, helmet: LIT } : look,
    pose,
  )
}

/** Where both hands are, held out by `arm`, for whatever is carried in them. */
export function handsOf(view: View, hand: Body, arm: number): [number, number, number] {
  const [x, y, z] = view.at(hand.x, hand.z)
  const heading = view.facing(hand.heading)
  const forward = -0.62 * Math.sin(arm)
  return [x + forward * Math.sin(heading), y + 1.38 - 0.62 * Math.cos(arm), z + forward * Math.cos(heading)]
}

/** A room's scene: it keeps what it needs between frames, and draws itself each frame. */
export interface RoomScene {
  step(view: View): void
}

/** How long a demonstration has to have said the same thing before its room's scene acts on it. */
const HOLDS = 0.15

/**
 * The scenes of the rooms that have one, each made when its room is first reached and kept, so a
 * room left and come back to is found as it was.
 */
export class Rooms {
  private readonly made: Partial<Record<RoomKey, RoomScene>> = {}
  private readonly clocks: Partial<Record<RoomKey, number>> = {}
  private readonly makers: Partial<Record<RoomKey, () => RoomScene>>
  /** The light the room last stepped asked for, if it asked for one. */
  lit: Light | null = null
  /** What each room's demonstration last said and since when, and what its scene is following. */
  private readonly said: Partial<
    Record<RoomKey, { now: Showing | undefined; since: number; held: Showing | undefined }>
  > = {}

  constructor(makers: Partial<Record<RoomKey, () => RoomScene>>) {
    this.makers = makers
  }

  /** Plays a room's scene on by `dt`. False if the room has none. */
  step(
    room: RoomKey,
    dt: number,
    box: Box,
    chips: Chips,
    still: boolean,
    showing: Showing | undefined,
  ): boolean {
    const maker = this.makers[room]
    if (!maker) return false
    const scene = this.made[room] ?? maker()
    this.made[room] = scene
    const clock = (this.clocks[room] ?? 0) + (still ? 0 : dt)
    this.clocks[room] = clock
    // Somebody dragging a control passes through values faster than anything could act them
    // out. The scene follows what has held for a moment, so a drag is one change and not thirty.
    const said = this.said[room] ?? { now: showing, since: clock - HOLDS, held: showing }
    this.said[room] = said
    if (said.now !== showing) {
      said.now = showing
      said.since = clock
    }
    if (still || clock - said.since >= HOLDS) said.held = said.now
    this.lit = null
    scene.step(
      viewOf(room, clock, still ? 0 : dt, still, box, chips, said.held, (lit) => {
        this.lit = lit
      }),
    )
    return true
  }
}

/** A point in a room: along it, in from the back wall, and up from the floor. */
export type Point = readonly [number, number, number]

/**
 * Where something sprung from one point to another is, `t` of the way there: one arc, `over`
 * blocks above the straight line at its top.
 */
export const flight = (a: Point, b: Point, t: number, over: number): Point => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t + over * 4 * t * (1 - t),
]

/** A place part-way from one to another: `across` of the way over the floor, `up` of the way in height. */
export const between = (a: Point, b: Point, across: number, up: number): Point => [
  lerp(a[0], b[0], across),
  lerp(a[1], b[1], across),
  lerp(a[2], b[2], up),
]

/** The small world at a place in the room: the middle of its underside, how it is turned, how big. */
export function small(view: View, at: Point, heading: number, scale: number): void {
  const [x, y, z] = view.at(at[0], at[1], at[2])
  smallWorld(view.box, { x, y, z, heading, inside: view.inside, scale }, 'survival', view.clock)
}

/** A block of something between two corners in the room's terms, `tall` from `h` up. */
export function slab(
  view: View,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  h: number,
  tall: number,
  tone: number,
  kind: number,
): void {
  if (tall < 0.01) return
  const [ax, y, az] = view.at(u0, v0, h)
  const [bx, , bz] = view.at(u1, v1, h)
  view.box(
    Math.min(ax, bx),
    y,
    Math.min(az, bz),
    Math.abs(bx - ax),
    tall,
    Math.abs(bz - az),
    tone,
    kind,
    0,
    view.inside,
  )
}

/**
 * How a head must turn and tip to look at a place in the room, from where its body stands and the
 * way that faces: no further round than a neck goes, and back no further than `up`.
 */
export function headTo(body: Body, to: Point, handed: number, up: number): [number, number] {
  const du = to[0] - body.x
  const dv = to[1] - body.z
  const round = wrap(headingOf([du, dv]) - body.heading)
  return [clamp(round, -1.15, 1.15) * handed, clamp(Math.atan2(1.7 - to[2], Math.hypot(du, dv)), -up, 0.5)]
}

/** How fast a pulse runs its wire, in blocks a second: the same in every room. */
export const PULSE = 8

/** Redstone along a room's floor, from point to point in the room's terms. */
export function wireIn(view: View, points: readonly Spot[]): void {
  for (let n = 0; n + 1 < points.length; n++) {
    const [ax, y, az] = view.at((points[n] as Spot)[0], (points[n] as Spot)[1])
    const [bx, , bz] = view.at((points[n + 1] as Spot)[0], (points[n + 1] as Spot)[1])
    wire(view.box, ax, az, bx, bz, y, view.inside)
  }
}

/** Something on its way along that redstone: `through` is how far, 0 to 1. */
export function pulseIn(view: View, points: readonly Spot[], through: number): void {
  if (through <= 0 || through >= 1) return
  const [, y] = view.at(0, 0)
  pulse(
    view.box,
    points.map((point) => {
      const [x, , z] = view.at(point[0], point[1])
      return [x, z] as const
    }),
    through,
    y,
    view.inside,
  )
}

/**
 * A pulse that set out along that redstone `since` seconds ago, at the one speed pulses have.
 * True once it has arrived. With `dies` its wire meets nothing at the far end, and it ends there
 * in a spark.
 */
export function runIn(view: View, points: readonly Spot[], since: number, dies = false): boolean {
  let long = 0
  for (let n = 0; n + 1 < points.length; n++) {
    const a = points[n] as Spot
    const b = points[n + 1] as Spot
    long += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  const takes = long / PULSE
  pulseIn(view, points, since / takes)
  if (dies) {
    const end = points[points.length - 1] as Spot
    const [x, y, z] = view.at(end[0], end[1])
    spark(view.box, x, y, z, since - takes, view.inside)
  }
  return since >= takes
}

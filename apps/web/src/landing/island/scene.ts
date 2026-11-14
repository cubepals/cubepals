// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The island on the first screen: the landing's chunk cut to a cube of world, printed in the
 * site's one-bit dither, with its friends, its sheep and its house. It plays the page's one idea
 * as a scene: asleep under the moon with nobody about, then someone joins, the light comes up, the
 * windows and the chimney come on and the friends walk in; when they have all gone, it goes back
 * to sleep. It knows nothing about the page: it is told what was asked (`Input`), steps and draws
 * a frame when asked (`frame`), and says where its marks are on the picture so the page can set
 * its labels there. It runs in a worker (island.worker.ts), off the page's own thread. Not the
 * drawing, which is engine/gl.ts, nor who moves, which is engine/cast.ts.
 */
import { type Camera, cameraOf, type Pose, project } from '../engine/camera'
import { Cast } from '../engine/cast'
import { buildChunk, HOME, LIT, SIZE, SURFACE_Y, TOP } from '../engine/chunk'
import { clamp, inOut } from '../engine/curves'
import type { Frame, Palette } from '../engine/frame'
import { Renderer } from '../engine/gl'
import { INK, keyAt, lookAt, PAPER } from '../engine/light'
import { Loose } from '../engine/loose'
import { hash3, Kind, Mesh, type World } from '../engine/world'
import { fitted } from './dots'

/** What the visitor asked of the server: everyone in, or everyone out. */
export type Asked = 'join' | 'leave'

/** What the server is doing, as its owner's page would say it, and how many are on it. */
export type Power = 'sleeping' | 'starting' | 'online' | 'emptying'

/** What the page tells the scene. */
export interface Input {
  asked: Asked
  /** How far the first screen has been scrolled away, 0 to 1: the camera rises with it. */
  rise: number
  /** Where the mouse is over the page, -1 to 1 across and down: the camera leans a little toward it. */
  lean: readonly [number, number]
  /** Less motion asked for: everything is at once where it would end, and nothing moves. */
  still: boolean
}

/** A point on the picture, as fractions of its width and height; null where it is behind the eye. */
type Spot = readonly [number, number] | null

/** Where the scene's marks are on the picture. */
export interface Marks {
  /** The chimney's top, where a sleeping server's snore comes out. */
  chimney: Spot
  /** The cube's middle: which way is out from it. */
  middle: Spot
  /** The near side's bottom edge, end to end: where the cube's width is measured. */
  from: Spot
  to: Spot
  /** The right-hand corner at the grass, and below it at the cut: where its levels are marked. */
  grass: Spot
  cut: Spot
  /** What the marks say: the cube's width in blocks, and the Minecraft levels of the grass and the cut. */
  across: number
  grassY: number
  cutY: number
}

/** What a frame reports: the server's state, how many are on it, and whether to keep drawing. */
export interface Stepped {
  power: Power
  players: number
  busy: boolean
}

/** How many blocks of ground are kept under the grass: the chunk is cut to a cube. */
const DEPTH = 11
/** The chimney's top, as engine/chunk.ts builds it. */
const CHIMNEY = [3.5, 8.6, 3.5] as const
/** The top of the grass, in blocks: the ground's top layer, Minecraft's `SURFACE_Y`, stands from 0 to 1. */
const GRASS = 1
/** How many friends join. */
const FRIENDS = 3
/** Seconds for the light to come up once someone joins, and to go once the last has left. */
const DAWN = 1.8
const DUSK = 1.4
/** Seconds the server takes to start in the scene: the windows come on through it. */
const STARTING = 1.6
/** Seconds after the last friend has gone before it sleeps. */
const SETTLES = 0.8
/** How many steps the light's way is taken in, between the moon and the sun: a shadow map each. */
const SHADES = 6
/** How long chips of wood and splashes of water last, in seconds. */
const CHIPS_FOR = 0.7

/**
 * Where the camera stands: looking at the cube's middle from a little above and to one side,
 * through a long lens, so the cube reads as a drawing does, with its near corner toward the eye.
 */
const BASE: Pose = {
  x: SIZE / 2,
  y: -1.6,
  z: SIZE / 2,
  az: 41,
  el: 27,
  span: 31,
  fov: 18,
  side: 0.5,
  drop: 0.5,
  crowd: 0,
  under: 0,
  inside: 0,
  bright: 1,
}

/** The cube's middle: what the camera's distance is measured from, and which way is out. */
const MIDDLE = [SIZE / 2, (GRASS - DEPTH) / 2, SIZE / 2] as const

/** What the camera's numbers are smoothed with, in seconds: the scroll moves it, never in one frame. */
const WEIGHT = 0.22

/** A chip of wood or splash of water, flying from where it came off. */
interface Chip {
  at: readonly [number, number, number]
  speed: readonly [number, number, number]
  born: number
  size: number
}

/** The camera the scene opens with, before any scroll or mouse, for a picture of `aspect`. */
export const openingCamera = (aspect: number): Camera => cameraOf(BASE, aspect, MIDDLE, 40)

/**
 * Whether the island has to be drawn again: something moved, the light is still on its way, or the
 * server is between two states (started but not yet up, emptied but not yet asleep), which only
 * time moves on. Without the last, everyone leaving before a friend came would stop the drawing
 * once the light had gone, with the server still emptying and its card showing it online.
 */
export function keepsDrawing(now: {
  drawn: boolean
  moving: boolean
  lamps: number
  day: number
  power: Power
}): boolean {
  return (
    now.drawn ||
    now.moving ||
    now.lamps % 1 !== 0 ||
    now.day % 1 !== 0 ||
    now.power === 'starting' ||
    now.power === 'emptying'
  )
}

/** Where the scene's marks are on the picture `lens` draws. */
export function marksOf(lens: Camera | null): Marks {
  const levels = { across: SIZE, grassY: SURFACE_Y, cutY: SURFACE_Y + GRASS - DEPTH }
  if (!lens) return { chimney: null, middle: null, from: null, to: null, grass: null, cut: null, ...levels }
  const at = (point: readonly [number, number, number]) => project(lens, point)
  return {
    ...levels,
    chimney: at(CHIMNEY),
    middle: at(MIDDLE),
    from: at([0, GRASS - DEPTH, SIZE]),
    to: at([SIZE, GRASS - DEPTH, SIZE]),
    grass: at([SIZE, GRASS, 0]),
    cut: at([SIZE, GRASS - DEPTH, 0]),
  }
}

export class Island {
  private readonly renderer: Renderer
  private readonly world: World
  private readonly mesh: Mesh
  private readonly cast = new Cast()
  private readonly loose = new Loose()
  private readonly groups = new Float32Array(16)
  private readonly bands: [Palette, Palette, Palette, Palette]
  private input: Input = { asked: 'join', rise: 0, lean: [0, 0], still: false }
  private pose: Pose = { ...BASE }
  private camera: Camera | null = null
  private width = 1
  private height = 1
  private unit = 1
  /** How far the day has come, 0 at night to 1 by day, and the step its light is cast in. */
  private day = 0
  private shade = -1
  /** How far the windows and the lamp have come on. */
  private lamps = 0
  private power: Power = 'sleeping'
  /** How long the server has been in its present state, in seconds. */
  private held = 0
  private clock = 0
  private chips: Chip[] = []
  private dirty = true

  constructor(canvas: OffscreenCanvas | HTMLCanvasElement) {
    this.renderer = new Renderer(canvas)
    this.world = buildChunk()
    this.mesh = new Mesh(this.world, null)
    this.renderer.setWorld(this.mesh, this.world)
    const print: Palette = { low: INK, high: PAPER, line: INK }
    this.bands = [print, print, print, print]
  }

  /** Whether the lit print has compiled: until then the page keeps its printed still. */
  get lit(): boolean {
    return this.renderer.lit
  }

  /** The box the picture is printed for, in CSS pixels, and how many device pixels one is. */
  resize(width: number, height: number, ratio: number): void {
    // As many whole dots as fit: the page sets the canvas to exactly that many (dots.ts).
    const print = fitted(width, height, ratio)
    this.unit = print.unit
    this.width = print.across
    this.height = print.down
    this.renderer.resize(this.width, this.height)
    this.dirty = true
  }

  /** What the page asks now. A change of mind halfway is taken from where things stand. */
  set(input: Input): void {
    if (input.asked !== this.input.asked) this.held = 0
    if (input.still && !this.input.still) this.settle(input.asked)
    this.input = input
    this.dirty = true
  }

  /** Straight to where things end for what is asked: with less motion, nothing is seen getting there. */
  private settle(asked: Asked): void {
    const on = asked === 'join'
    this.power = on ? 'online' : 'sleeping'
    this.day = on ? 1 : 0
    this.lamps = on ? 1 : 0
    this.chips = []
  }

  /** Where the camera wants to be: the base, risen with the scroll and leaning toward the mouse. */
  private goal(): Pose {
    const { rise, lean } = this.input
    const up = inOut(clamp(rise))
    return {
      ...BASE,
      el: BASE.el + up * 9 + lean[1] * 1.6,
      az: BASE.az + lean[0] * 2.4,
      span: BASE.span * (1 + up * 0.08),
      drop: BASE.drop - up * 0.05,
    }
  }

  /** The server's state, moved on by `dt` seconds: what the cast and the light follow. */
  private stepPower(dt: number): void {
    this.held += dt
    const next = this.nextPower()
    if (next !== this.power) {
      this.power = next
      this.held = 0
    }
    const on = this.power === 'starting' || this.power === 'online'
    const lit = on || (this.power === 'emptying' && this.cast.about)
    this.lamps = clamp(this.lamps + (lit ? dt / STARTING : -dt / DUSK))
    this.day = clamp(this.day + (lit ? dt / DAWN : -dt / DUSK))
  }

  /**
   * What the server does next, given what was asked: a join starts it and it comes up after its
   * start; a leave empties it, and once the last friend has walked off it settles and sleeps.
   */
  private nextPower(): Power {
    const { power, held } = this
    if (this.input.asked === 'join') {
      if (power === 'sleeping' || power === 'emptying') return 'starting'
      return power === 'starting' && held >= STARTING ? 'online' : power
    }
    if (power === 'starting' || power === 'online') return 'emptying'
    return power === 'emptying' && !this.cast.about && held >= SETTLES ? 'sleeping' : power
  }

  /**
   * One frame, `now` milliseconds since the scene began: the server's state and the cast moved on,
   * the camera eased toward its goal, and the picture drawn if anything changed. With less motion
   * asked for, nothing moves and the picture is drawn only when something is asked.
   */
  frame(now: number): Stepped {
    const time = now / 1000
    const dt = this.input.still ? 0 : Math.min(0.1, Math.max(0, time - this.clock))
    this.clock = time
    if (this.input.still) this.settle(this.input.asked)
    else this.stepPower(dt)

    const goal = this.goal()
    const ease = this.input.still ? 1 : 1 - Math.exp(-dt / WEIGHT)
    let moving = false
    for (const key of ['az', 'el', 'span', 'drop'] as const) {
      const gap = goal[key] - this.pose[key]
      if (Math.abs(gap) > 0.0005) moving = true
      this.pose[key] += gap * ease
    }

    const drawn = this.drawFrame(dt, time, moving)
    return {
      power: this.power,
      players: this.cast.present,
      busy: keepsDrawing({ drawn, moving, lamps: this.lamps, day: this.day, power: this.power }),
    }
  }

  private drawFrame(dt: number, time: number, moving: boolean): boolean {
    const want = this.power === 'online' ? FRIENDS : 0
    this.loose.clear()
    const put = this.loose.put
    const quiet = this.input.still
    const chips = quiet
      ? () => {}
      : (
          at: readonly [number, number, number],
          out: readonly [number, number, number],
          count: number,
          size = 0.43,
        ) => this.scatter(at, out, count, time, size)
    const castBusy = this.cast.friendsStep(want, dt, put, chips, HOME, quiet, quiet && want > 0)
    this.putChips(time)
    this.renderer.setMoving(this.loose)

    // The light's way follows the day in a few steps, like the frames of a drawn sunrise: the
    // shadow map is cast again only when it moves.
    const shade = Math.round(this.day * SHADES)
    if (shade !== this.shade) {
      this.shade = shade
      this.dirty = true
    }

    this.camera = cameraOf(this.pose, this.width / this.height, MIDDLE, 40)
    const lens = this.camera
    this.groups[HOME] = inOut(this.lamps)
    this.groups[LIT] = 0.25 + 0.75 * inOut(this.lamps)
    const look = lookAt(inOut(this.day), 0)
    const frame: Frame = {
      camera: lens.matrix,
      shift: lens.shift,
      key: keyAt(shade / SHADES),
      ...look,
      shadows: { middle: [SIZE / 2, 3, SIZE / 2], radius: 16, runs: this.mesh.between(-8, TOP) },
      levels: 0,
      detail: 1,
      groups: this.groups,
      bands: this.bands,
      edges: [1e6, 1e6, 1e6, 1e6],
      regions: [0, 0, 0, 0, 0],
      // The one warm colour of the old print is paper here: a lit window is light, not a hue.
      warm: PAPER,
      stars: false,
      star: PAPER,
      unit: this.unit,
      torch: null,
      time: quiet ? 0 : time,
      pick: null,
      runs: this.mesh.between(GRASS - DEPTH, TOP),
      farRuns: [],
      eye: lens.eye,
      fog: [lens.distance * 4, lens.distance * 4],
      crowd: 0,
    }
    if (this.dirty || moving || castBusy || this.chips.length > 0 || dt > 0 || !this.renderer.lit) {
      this.renderer.draw(frame)
      this.dirty = false
    }
    return castBusy || this.chips.length > 0
  }

  /** Where the scene's marks are on the picture now. */
  marks(): Marks {
    return marksOf(this.camera)
  }

  /** Chips off what someone is working at: a few small blocks, thrown out and falling. */
  private scatter(
    at: readonly [number, number, number],
    out: readonly [number, number, number],
    count: number,
    time: number,
    size: number,
  ): void {
    const [x, y, z] = at
    for (let n = 0; n < count; n++) {
      const r = (salt: number) => hash3(x * 7 + n, y * 13 + salt, z * 5 + Math.floor(time * 10)) - 0.5
      this.chips.push({
        at: [x + r(1) * 0.6, y + r(2) * 0.6 + out[1] * 0.4, z + r(3) * 0.6],
        speed: [out[0] * 2.4 + r(4) * 3.2, out[1] * 2.4 + 2.6 + r(5) * 2, out[2] * 2.4 + r(6) * 3.2],
        born: time,
        size,
      })
    }
  }

  private putChips(time: number): void {
    this.chips = this.chips.filter((chip) => time - chip.born < CHIPS_FOR)
    for (const chip of this.chips) {
      const age = time - chip.born
      const size = chip.size * (1 - (age / CHIPS_FOR) ** 2)
      this.loose.put(
        chip.at[0] + 0.5 + chip.speed[0] * age - size / 2,
        chip.at[1] + 0.5 + chip.speed[1] * age - 9 * age * age - size / 2,
        chip.at[2] + 0.5 + chip.speed[2] * age - size / 2,
        size,
        size,
        size,
        255,
        Kind.wool,
        0,
        0,
      )
    }
  }

  dispose(): void {
    this.renderer.dispose()
  }
}

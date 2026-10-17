// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The canvas the whole page is drawn on, and its director: it builds the chunk once, reads each
 * beat's shot off the page, flies the camera between them, turns night and day, lights the rooms,
 * steps the cast and the room scenes, prints it all, and answers the pointer (the crosshair's
 * block, digging). The drawing itself is engine/gl.ts; who moves is engine/cast.ts.
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import {
  type Camera,
  cameraOf,
  POSE_KEYS,
  type Pose,
  pick,
  project,
  rayThrough,
  rowOf,
} from './engine/camera'
import { Cast, DAYLIGHT } from './engine/cast'
import {
  BOTTOM,
  buildChunk,
  CELLAR,
  groupOf,
  HOME,
  LIT,
  ROOMS,
  type RoomKey,
  roomPlace,
  SIZE,
  SURFACE_Y,
  TOP,
} from './engine/chunk'
import { clamp, inOut, lerp } from './engine/curves'
import { buildFleet, COHORTS, type Fleet, farRunsOf, type Island } from './engine/fleet'
import type { Packed, Palette } from './engine/frame'
import { Renderer } from './engine/gl'
import { Ground } from './engine/ground'
import { Handover } from './engine/handover'
import { DAY_KEY, DIG, INK, keyAt, lookAt, mix, NIGHT, PAPER, TORCH } from './engine/light'
import { Loose } from './engine/loose'
import { hash3, Kind, Mesh, relight, type Taken, type World } from './engine/world'
import { playing } from './film/clock'
import { choice } from './sections/choice'
import { type Aim, stage } from './stage'
import { FIRST_CANVAS, nextCanvas, RESTORED_WITHIN_MS, withoutDrawing } from './start'
import { type Torch, torchOf } from './torch'
import { director, type Shot, shotsOf } from './views'

/**
 * Which palette the print takes over each kind of ground: the hero's sky, the light grounds, the
 * dark ones of the dig (light dots on dark, shadows black), night.
 */
const bandOf = (tone: string): number =>
  tone === 'night' ? 0 : tone === 'dusk' ? 3 : tone === 'slate' || tone === 'bedrock' ? 2 : 1

/** How much weight the camera's spring has, in seconds. The first screen opens still, as it is. */
const WEIGHT = 0.17
/** Where the camera is until the page has said where it should be. */
const OPENING: Pose = {
  x: 8,
  y: 0,
  z: 8,
  az: 42,
  el: 20,
  span: 34,
  fov: 26,
  side: 0.5,
  drop: 0.5,
  crowd: 0,
  under: 0,
  inside: 0,
  bright: 1,
}

/** How close to its goal each of the camera's values has to be to count as there. */
const WITHIN: Record<keyof Pose, number> = {
  x: 0.004,
  y: 0.004,
  z: 0.004,
  az: 0.01,
  el: 0.01,
  span: 0.0006,
  fov: 0.01,
  side: 0.0003,
  drop: 0.0003,
  crowd: 0.002,
  under: 0.002,
  inside: 0.002,
  bright: 0.002,
}

const smooth = (t: number) => t * t * (3 - 2 * t)
/** How far the sky has turned: it waits for the moon to set and the stars to go out (landing.css, `--lit`). */
/** The most pixels the print is ever drawn at: a little over a 1920 by 1080 screen's worth. */
const MOST_DRAWN = 2_300_000

const dawnOf = (day: number) => smooth(clamp((day - 0.45) / 0.55))

/** What the shadow map covers: the grass and everything that stands on it. */
const SHADED = [SIZE / 2, 3, SIZE / 2] as const

/** The middle of the chunk, and how far from it anything of the chunk can be. */
export const MIDDLE = [SIZE / 2, (TOP + BOTTOM) / 2, SIZE / 2] as const
export const AROUND = 80
/** How far out the other worlds go, when they are there. */
const AROUND_ALL = 330

/** How long a hole stays before the block grows back, how long it takes to, and how long chips fly. */
const REGROWS_AFTER = 9000
const GROWS_FOR = 420
const PIECES_FOR = 0.7

/**
 * What a click may dig out: the ground itself and the leaves. Everything that was built (the
 * house, the lamps, what stands in the rooms, the path people walk on) is kept, because the page's
 * story is told with it; water only splashes; and bedrock is bedrock.
 */
const DIGGABLE: ReadonlySet<number> = new Set([
  Kind.grass,
  Kind.dirt,
  Kind.stone,
  Kind.deepslate,
  Kind.ore,
  Kind.sand,
  Kind.leaves,
])

/** What the chunk says, in the game's voice, about a click that didn't dig. */
const SAYS = {
  kept: 'Cubepals needs that one.',
  stood: 'Somebody is standing there.',
  bedrock: 'Bedrock. Same as in the game.',
  back: 'Put back from a backup.',
}

/**
 * The chunk and the worlds round it take a moment to build, and nothing about them depends on
 * who is looking, so they are built once and kept for as long as the page's code is: coming back
 * to the page, or the page mounting twice in development, finds them ready.
 */
let built: { world: World; mesh: Mesh } | null = null
let fleets: { fleet: Fleet; reach: number } | null = null

/** The chunk and its mesh, built if they aren't yet. */
function prepared(): { world: World; mesh: Mesh } {
  if (!built) {
    const world = buildChunk()
    built = { world, mesh: new Mesh(world, null) }
  }
  return built
}

/** The other worlds round this one, `reach` worlds out, built if they aren't yet. */
function fleetOf(reach: number): Fleet {
  if (fleets?.reach !== reach) fleets = { fleet: buildFleet(reach, DAY_KEY), reach }
  return fleets.fleet
}

/** A piece of a block that was just dug out, on its way to the ground. */
interface Piece {
  at: [number, number, number]
  speed: [number, number, number]
  born: number
  /** How big it is, in blocks. */
  size: number
}

/**
 * The chunk, and the camera that travels it. One canvas covers the screen and stays in view while
 * the page scrolls; where the page is decides what the camera looks at, from which way round, how
 * high and how close, and it flies between one section's view and the next: round the corner of
 * the chunk, down a level, in through a room's open wall, out until the whole column is in view,
 * and further out still, to where this world is one of a great many. What the stage says decides
 * whether it is night or day, who is standing on the path and which room has its lamps lit.
 *
 * The pointer is part of it. Moving it leans the camera a little, the block under it is marked the
 * way the game marks one, and a click digs that block out; it grows back.
 *
 * Sections steer the camera with attributes, so they can stay plain server-rendered markup:
 * `data-y` (the Minecraft Y to look at) or `data-room` (the room to look into, and to light),
 * `data-side` (where across the screen to hold it), `data-zoom` (how close), and to say more,
 * `data-az`, `data-el`, `data-span`, `data-fov`, `data-drop`, `data-turn` and `data-crowd` (see
 * `Pose`). The print takes its palette from the `data-tone` of the ground behind it. An element with
 * `data-pin="<room>"` is moved to wherever that room's opening is drawn, so a label can sit on the
 * drawing, and one with `data-scene` lets the pointer through to the blocks behind it.
 */
export function Chunk() {
  const ref = useRef<HTMLCanvasElement>(null)
  // A context that fails to start, or is lost and never given back, gets a new canvas (start.ts).
  const [drawnOn, renew] = useReducer(nextCanvas, FIRST_CANVAS)
  // After the first paint the chunk is built, and a task later the print's shaders are compiled.
  const [painted, setPainted] = useState(false)
  useEffect(() => {
    let timer = 0
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        prepared()
        timer = window.setTimeout(() => setPainted(true))
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const canvas = ref.current
    const root = canvas?.closest<HTMLElement>('[data-landing]')
    if (!canvas || !root || !painted) return
    let renderer: Renderer
    try {
      renderer = new Renderer(canvas)
    } catch {
      return withoutDrawing(root, drawnOn, () => renew(true))
    }

    const still = window.matchMedia('(prefers-reduced-motion: reduce)')
    // On a narrow screen the canvas is a band across the top rather than the whole screen.
    const narrow = window.matchMedia('(max-width: 1023px)')
    const mouse = window.matchMedia('(hover: hover) and (pointer: fine)')

    const { world, mesh } = prepared()
    renderer.setWorld(mesh, world)
    // The other worlds, seen only at the end, are built a while after; as many as the width wants.
    let fleet: Fleet | null = null
    const refleet = () => {
      fleet = fleetOf(narrow.matches ? 4 : 8)
      renderer.setFar(fleet)
      dirty = true
    }
    const gathering = window.setTimeout(refleet, 2000)

    const spine = canvas.parentElement
    // What takes the sky's colour: the section that is the sky, and the band the chunk is drawn in
    // on a narrow screen, which is night while that section passes under it.
    const skies = [...root.querySelectorAll<HTMLElement>('[data-sky]'), ...(spine ? [spine] : [])]
    // The grounds the page is made of, top to bottom: where each begins and ends, and its tone.
    let layers: { top: number; bottom: number; tone: string }[] = []
    let shots: Shot[] = []
    let pins: { element: HTMLElement; room: RoomKey; top: number; bottom: number }[] = []
    let unit = 1
    // Where the canvas is on the screen, read when the page moves and not on every frame.
    let box = canvas.getBoundingClientRect()
    // A device that can't keep up gets a coarser print, a step at a time. One that was only busy
    // for a while gets the finer print back, twice at most, so it never flickers between the two.
    let coarse = 0
    let quick = 0
    let recovered = 0
    // Trying another look, from the address bar: ?span= how many blocks a room's view is tall,
    // ?rock= how quiet the rock prints, ?px= how many device pixels one drawn dot is, ?ex= how much
    // brighter the print is taken, ?ct= its contrast.
    const trying = new URLSearchParams(window.location.search)
    let slow = 0
    let drewAt = 0
    let dayWas = ''
    let dirty = true
    let visible = true
    // The page moved (a scroll, a resize): where the camera should be has to be read again.
    let moved = true
    let lost = false
    // How much of the upper screen is under the hero's sky, and how much under the night.
    let underSky = 1
    let underNight = 0
    // Whether neither dark sky is anywhere on screen: their stars then hold still.
    let skyless = false
    let room: RoomKey | null = null
    let act: string | null = null
    let goal: Pose = OPENING
    let view: Pose | null = null
    // How fast each of the camera's values is moving, in the order of POSE_KEYS.
    const velocity = new Float64Array(POSE_KEYS.length)
    // How fast the page itself is being scrolled, in screen pixels a millisecond, smoothed.
    let scrollSpeed = 0
    let scrolledY = window.scrollY
    let scrolledTime = 0

    // What is animating: the day, the house's lights, each room's lamps, and who is on the path.
    let day = stage.get().power === 'awake' ? 1 : 0
    let home = 0
    let shadedAt = -1
    // The light the blocks' own shadow bits were last worked out for, when the map is given up.
    let bitsAt = -1
    const lamps = new Float32Array(16)
    const groups = new Float32Array(16)
    // Who is about on the grass, and what the cellar holds.
    const cast = new Cast()
    let castAt = 0
    let castBeat = -1
    let castBusy = false
    // Whether the grass is anywhere on screen: nobody up there moves while nobody could see them.
    let surfaceSeen = true
    // And near enough that who is on it can be made out.
    let surfaceNear = true
    // Whether the camera is close enough to a room for whoever is in it to be made out.
    let roomSeen = false
    // The daylight the chosen way to play is seen by, eased from one to the next.
    let playLight = 1

    // The pointer: where it is, how far the camera leans toward it, and the block it is on.
    let pointer: { x: number; y: number } | null = null
    let aimed = false
    const lean = { az: 0, el: 0 }
    let leanTo = { az: 0, el: 0 }
    let picked: { cell: [number, number, number]; normal: [number, number, number] } | null = null
    let aiming: Aim = null
    // A kept block that was just knocked on shows itself for a moment.
    let knocked: { cell: [number, number, number]; until: number } | null = null
    let camera: Camera | null = null
    const holes: { taken: Taken; until: number }[] = []
    // The blocks somebody or something is standing on, frame by frame: those are kept.
    const ground = new Ground()
    // Blocks on their way back: each grows from nothing into its place.
    let growing: { taken: Taken; born: number; size: number }[] = []
    let grewAt = 0
    let pieces: Piece[] = []
    let dug = stage.get().dug
    // What moves is written into the same two arrays every frame; they grow when they have to.
    const farRuns: [number, number, number][] = []
    const farSeen: Island[] = []
    // A light that isn't part of the world: where it is, how far it reaches (blocks), how bright,
    // and what it lights (out of doors, or one room).
    const torchLight: Torch = [0, 0, 0, 3.8, 0, HOME]
    // What every frame hands the renderer, kept between frames.
    const bands: [Palette, Palette, Palette, Palette] = [
      { low: INK, high: NIGHT, line: INK },
      { low: INK, high: PAPER, line: INK },
      DIG,
      { low: INK, high: NIGHT, line: INK },
    ]
    let skyFor = ''

    // Where a frame's time went, for the trace: relighting, measuring the page, writing to it.
    const spent = { relight: 0, measures: 0, dom: 0 }

    const measure = () => {
      const measuring = performance.now()
      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width === 0 || height === 0) return
      const band = narrow.matches
      // One drawn dot is a whole number of device pixels, so the print never blurs: two at one
      // device pixel to a screen pixel, three at two, so it reads as a print and not as grey.
      const base = Number(trying.get('px')) || Math.max(2, Math.round(dpr * 1.5))
      // Each step coarser is at least one device pixel, so a step always does something.
      unit = (base + coarse * Math.max(1, Math.round(dpr / 2))) / dpr
      // However big the screen, the print is no more than about two million drawn pixels: a
      // very large display gets a grain a step coarser, not several times the work.
      while ((width / unit) * (height / unit) > MOST_DRAWN) unit += 1 / dpr
      box = canvas.getBoundingClientRect()
      renderer.resize(Math.ceil(width / unit), Math.ceil(height / unit))
      // What each distance means: how many blocks fit top to bottom, the lens, and the height the
      // camera stands at. "Far" is the whole column, drawn nearly flat.
      shots = shotsOf(root, band, trying)
      // The edge between two strata is drawn on the lighter ground, so it counts as paper.
      layers = [...root.querySelectorAll<HTMLElement>('.bl-dig > [data-tone], .bl-dig > .bl-strata')]
        .filter((element) => element !== spine)
        .map((element) => {
          const box = element.getBoundingClientRect()
          return {
            top: box.top + window.scrollY,
            bottom: box.bottom + window.scrollY,
            tone: element.dataset.tone ?? 'paper',
          }
        })
        .sort((a, b) => a.top - b.top)
      pins = [...root.querySelectorAll<HTMLElement>('[data-pin]')].map((element) => {
        // The scene a label is written on: it is only placed while that scene is on screen.
        const scene = (element.closest<HTMLElement>('.bl-section') ?? element).getBoundingClientRect()
        return {
          element,
          room: element.dataset.pin as RoomKey,
          top: scene.top + window.scrollY,
          bottom: scene.bottom + window.scrollY,
        }
      })
      // A name that has never been placed is away as well: it has no place to lose that would say so.
      for (const pin of pins)
        pin.element.toggleAttribute('data-away', !band && pin.element.style.translate === '')
      moved = true
      dirty = true
      spent.measures += performance.now() - measuring
    }

    const wanted = director(still)

    // What moves in the world, written afresh every frame (engine/loose.ts).
    const loose = new Loose()
    const put = loose.put
    // The cast's boxes, and what a section puts on handed to the next through the print's dots.
    const handover = new Handover(put, ground)
    const actors = (time: number): Packed => {
      loose.clear()
      ground.next()
      // Whoever is on the grass: the friends who joined, each at something of their own, or,
      // beside the two questions, the way to play that is chosen. Nobody moves unseen.
      const quiet = still.matches
      // People are moved on every frame for as long as any are about (`castBusy`, from the frame
      // before): a figure that moves in jumps is unsettling. With nobody about, what is left (a
      // sheep's head, the fleet's lights) keeps the slow loop's ticks, as the water does.
      const beat = Math.floor(time * 9)
      const due = castBusy || beat !== castBeat
      // A beat hurried by the reader's scrolling has its picture hurried with it (film/clock.ts).
      const passed =
        quiet || !due || stage.get().held > 0 ? 0 : Math.min(0.25, Math.max(0, time - castAt) * playing.pace)
      if (due) {
        castAt = time
        castBeat = beat
      }
      // Nobody on the grass moves while nobody could make them out: from far off they stand still.
      const step = surfaceNear ? passed : 0
      const chips = quiet
        ? () => {}
        : (
            at: readonly [number, number, number],
            out: readonly [number, number, number],
            count: number,
            size?: number,
          ) => scatter(at, out, count, time * 1000, size)
      dirty = handover.step(time, act, room, roomSeen, quiet, !surfaceNear) || dirty
      if (!surfaceSeen) castBusy = false
      else if (handover.act === 'play')
        castBusy = cast.playStep(choice.get().play, step, handover.grass, chips, HOME, quiet)
      else {
        const now = stage.get()
        // At the page's last scenes everyone is in, whatever the server at the top is doing, and
        // is found already at what they do: nobody is watched walking in a second time.
        const closing = handover.act === 'friends'
        const count = closing ? 3 : now.power === 'awake' ? now.players : 0
        castBusy = cast.friendsStep(count, step, handover.grass, chips, HOME, quiet, closing)
        // Before anyone is in, whoever typed the address is at the end of the path with a torch.
        cast.callerStep(handover.act === 'knock', step, handover.grass, quiet)
        castBusy = castBusy || (handover.act === 'knock' && !quiet)
      }
      if (!surfaceNear) castBusy = false
      if ((lamps[CELLAR] ?? 0) > 0.02) {
        const chosen = choice.get()
        cast.cellar(stage.get().ledger, chosen.play, chosen.party, passed, handover.stand, quiet)
        castBusy = castBusy || !quiet
      }
      // Under the grass, the worker is in whichever room the page has reached. A demonstration
      // may have the room's lamps low or out; the worker is there all the same, by helmet lamp.
      if (handover.room) {
        cast.roomStep(handover.room, passed, handover.below, chips, quiet, stage.get().rooms[handover.room])
        castBusy = castBusy || !quiet
      }
      // Chips are bare paper whatever they came off, so a dig shows on the darkest rock.
      for (const piece of pieces) {
        const age = time - piece.born
        const size = piece.size * (1 - (age / PIECES_FOR) ** 2)
        put(
          piece.at[0] + 0.5 + piece.speed[0] * age - size / 2,
          piece.at[1] + 0.5 + piece.speed[1] * age - 9 * age * age - size / 2,
          piece.at[2] + 0.5 + piece.speed[2] * age - size / 2,
          size,
          size,
          size,
          255,
          Kind.wool,
          0,
          0,
        )
      }
      return loose
    }

    /** The block under the pointer, if the pointer is on the drawing and not on the words. */
    const aim = () => {
      aimed = false
      let hit: typeof picked = null
      if (pointer && camera && mouse.matches && !narrow.matches) {
        const over = document.elementFromPoint(pointer.x, pointer.y)
        const inside =
          pointer.x >= box.left && pointer.x < box.right && pointer.y >= box.top && pointer.y < box.bottom
        if (inside && over?.matches('.bl-section, .bl-strata, .bl-strata *, [data-scene]')) {
          const ray = rayThrough(
            camera,
            (pointer.x - box.left) / box.width,
            (pointer.y - box.top) / box.height,
          )
          hit = pick(world, camera.eye, ray)
        }
      }
      const kind = hit ? world.get(hit.cell[0], hit.cell[1], hit.cell[2]) : Kind.air
      // What somebody is standing on is kept, as what was built is.
      const stood = hit !== null && ground.has(hit.cell[0], hit.cell[1], hit.cell[2])
      const now: Aim = !hit
        ? null
        : kind === Kind.water
          ? 'water'
          : DIGGABLE.has(kind) && !stood
            ? 'dig'
            : 'kept'
      const same =
        now === aiming &&
        hit?.cell[0] === picked?.cell[0] &&
        hit?.cell[1] === picked?.cell[1] &&
        hit?.cell[2] === picked?.cell[2]
      picked = hit
      aiming = now
      if (!same) dirty = true
      if (stage.get().aim !== now) stage.set({ aim: now })
    }

    /** Chips thrown from a block: `out` is the way they mostly go. */
    const scatter = (
      cell: readonly [number, number, number],
      out: readonly [number, number, number],
      count: number,
      time: number,
      size = 0.43,
    ) => {
      const [x, y, z] = cell
      for (let n = 0; n < count; n++) {
        const r = (salt: number) => hash3(x * 7 + n, y * 13 + salt, z * 5 + dug + Math.floor(time)) - 0.5
        pieces.push({
          at: [x + r(1) * 0.6, y + r(2) * 0.6 + out[1] * 0.4, z + r(3) * 0.6],
          speed: [out[0] * 2.4 + r(4) * 3.2, out[1] * 2.4 + 2.6 + r(5) * 2, out[2] * 2.4 + r(6) * 3.2],
          born: time / 1000,
          size,
        })
      }
      dirty = true
    }

    /**
     * A click on the chunk. The ground and the leaves are dug out; water splashes and stays; what
     * was built is kept, and says so.
     */
    const strike = (time: number) => {
      if (!picked) return
      const [x, y, z] = picked.cell
      if (aiming === 'water') {
        if (!still.matches) scatter(picked.cell, [0, 1.4, 0], 7, time)
        return
      }
      // (Somebody may have walked onto it since the pointer last moved.)
      const stood = ground.has(x, y, z)
      if (aiming !== 'dig' || stood) {
        knocked = { cell: picked.cell, until: time + 220 }
        const kind = world.get(x, y, z)
        stage.say(kind === Kind.bedrock ? SAYS.bedrock : stood && DIGGABLE.has(kind) ? SAYS.stood : SAYS.kept)
        dirty = true
        return
      }
      const taken = world.take(x, y, z)
      if (!taken) return
      mesh.around(x, y, z, keyAt(Math.max(0, shadedAt) / 6))
      renderer.setWorld(mesh, world)
      holes.push({ taken, until: time + REGROWS_AFTER })
      if (!still.matches) scatter(picked.cell, picked.normal, 9, time)
      dug += 1
      stage.set({ dug })
      aimed = true
    }

    let last = 0
    let ambient = 0
    // The clock everything that moves by itself goes by. It stops while a demonstration on screen
    // is paused: that button is the page's way to hold still what nobody asked to move.
    let clock = 0
    let pausedWas = root.hasAttribute('data-paused')
    let raf = 0
    // While the page is being worked on, every drawn frame leaves a line behind: when it was, how
    // long its script took, and where the camera was. The screenshot tool reads them to find
    // frames that came late and places where the camera's motion isn't smooth. Not in a build.
    const trace: number[][] | null = process.env.NODE_ENV === 'production' ? null : []
    if (trace) (window as { __blTrace?: number[][] }).__blTrace = trace
    const frame = (time: number) => {
      raf = requestAnimationFrame(frame)
      if (!visible || lost || !renderer.ready) return
      const began = trace ? performance.now() : 0
      // A long gap between frames (a hidden tab) still moves things on by a fair step.
      const dt = Math.min(0.25, (time - last) / 1000)
      // Frames that had drawing to do and still came late, many in a row: the print gets coarser
      // by half a pixel, twice at most. A coarser print is still the print; a slow one is not.
      // Ten seconds of frames on time after that, and it is tried finer again.
      if (drewAt === last && time - last < 120) {
        // Forty milliseconds, not thirty: a laptop saving power draws at thirty frames a second
        // by choice, and that is not a device falling behind.
        slow = time - last > 40 ? slow + 1 : Math.max(0, slow - 2)
        quick = time - last > 24 ? 0 : quick + 1
        if (slow > 40 && coarse < 2) {
          coarse += 1
          slow = 0
          quick = 0
          measure()
        } else if (quick > 600 && coarse > 0 && recovered < 2) {
          coarse -= 1
          recovered += 1
          quick = 0
          measure()
        }
      }
      last = time
      const now = stage.get()
      const quiet = still.matches
      const paused = now.held > 0
      if (!paused) clock = time
      if (paused !== pausedWas) {
        pausedWas = paused
        root.toggleAttribute('data-paused', paused)
      }

      // Night falls when the server sleeps and lifts when someone is in; the lamps come on first.
      // It is day while the server is up, and it stays day until whoever was on has walked off:
      // nobody is left to find their way out in the dark.
      const dayTarget =
        now.power === 'awake' || now.power === 'saving' || (act !== 'play' && cast.about) ? 1 : 0
      const homeTarget = now.power === 'waking' ? 1 : now.power === 'awake' ? clamp(1 - dawnOf(day) * 1.6) : 0
      const stepDay = quiet ? 1 : dt / 2.4
      const stepHome = quiet ? 1 : dt / 0.5
      if (day !== dayTarget) {
        day = day < dayTarget ? Math.min(dayTarget, day + stepDay) : Math.max(dayTarget, day - stepDay)
        dirty = true
      }
      if (home !== homeTarget) {
        home =
          home < homeTarget ? Math.min(homeTarget, home + stepHome) : Math.max(homeTarget, home - stepHome)
        dirty = true
      }

      // How fast the page is moving, so a long ride can be told from a step to the next section.
      const pace = Math.abs(window.scrollY - scrolledY) / Math.max(1, time - scrolledTime)
      scrolledY = window.scrollY
      scrolledTime = time
      if (pace > 0 || scrollSpeed > 0) {
        scrollSpeed = lerp(scrollSpeed, pace, 1 - Math.exp(-dt * 6))
        if (scrollSpeed < 0.002) scrollSpeed = 0
        // Only a page that moved, or a ride still fast enough to flatten the camera's step back
        // (at 6 and under it is whole), has anywhere new for the camera to be.
        if (pace > 0 || scrollSpeed > 6) moved = true
      }
      if (moved) {
        moved = false
        // Where the canvas is on the screen: at the foot of the page it slides up with the page.
        box = canvas.getBoundingClientRect()
        const next = wanted(shots, goal, scrollSpeed)
        goal = next.view
        room = next.room
        act = next.act
        // Of the upper part of the screen, the share each dark sky covers.
        const reach = window.innerHeight * 0.7
        underSky = 0
        underNight = 0
        let starry = false
        for (const layer of layers) {
          if (layer.tone !== 'night' && layer.tone !== 'dusk') continue
          const top = layer.top - window.scrollY
          const bottom = layer.bottom - window.scrollY
          if (bottom > 0 && top < window.innerHeight) starry = true
          const share = clamp((Math.min(bottom, reach) - Math.max(top, 0)) / reach)
          if (layer.tone === 'night') underSky += share
          else underNight += share
        }
        if (starry === skyless) {
          skyless = !starry
          root.toggleAttribute('data-skyless', skyless)
        }
        aimed = true
      }
      // It follows as a weighted thing follows: each value is drawn toward its goal by a spring
      // with just enough drag that it never overshoots, so the camera gathers speed and sheds
      // it, and never starts or stops in one frame. Distance is eased by ratio, so a zoom feels
      // even from far and from near.
      const before: Pose = view ?? goal
      const here: Pose = { ...before }
      if (quiet || !view) {
        // With less motion asked for the camera cuts, and only when there is somewhere new to be.
        if (!view || POSE_KEYS.some((key) => before[key] !== goal[key])) {
          dirty = true
          aimed = true
        }
        Object.assign(here, goal)
        velocity.fill(0)
      } else {
        const omega = 2 / WEIGHT
        const k = omega * dt
        const decay = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k)
        for (let i = 0; i < POSE_KEYS.length; i++) {
          const key = POSE_KEYS[i] as keyof Pose
          const ratio = key === 'span'
          const to = ratio ? Math.log(goal.span) : goal[key]
          const from = ratio ? Math.log(before.span) : before[key]
          const within = WITHIN[key]
          const speed = velocity[i] as number
          if (Math.abs(from - to) < within && Math.abs(speed) < within * 4) {
            if (from !== to) dirty = true
            here[key] = goal[key]
            velocity[i] = 0
            continue
          }
          const change = from - to
          const carried = (speed + omega * change) * dt
          velocity[i] = (speed - omega * carried) * decay
          const next = to + (change + carried) * decay
          here[key] = ratio ? Math.exp(next) : next
          dirty = true
          // The camera moved under a pointer that may be holding still: what it is on has changed.
          aimed = true
        }
      }
      view = here
      const depth = Math.round(here.y + SURFACE_Y)
      if (now.y !== depth || now.room !== room) stage.set({ y: depth, room })

      // The camera leans a little toward the pointer, so the drawing is plainly a place.
      const leanPull = quiet ? 1 : 1 - Math.exp(-dt * 5)
      for (const key of ['az', 'el'] as const) {
        const to = quiet || narrow.matches ? 0 : leanTo[key]
        if (lean[key] === to) continue
        lean[key] = Math.abs(to - lean[key]) < 0.01 ? to : lerp(lean[key], to, leanPull)
        dirty = true
        aimed = true
      }

      // Night belongs to the sky over the sleeping server, and to the sky over all the worlds at
      // the end. Away from both the chunk is drawn by daylight, whatever the server is doing.
      const tone = spine?.dataset.tone
      const sky = narrow.matches
        ? tone === 'night'
          ? dawnOf(day)
          : tone === 'dusk'
            ? 0
            : 1
        : 1 - clamp(underSky * (1 - dawnOf(day)) + underNight)
      // Beside the two questions the grass shows the way to play that is chosen, each in its own
      // light: dusk for survival, deep night for hardcore, broad day for the rest.
      const mood = act === 'play' ? DAYLIGHT[choice.get().play] : 1
      if (playLight !== mood) {
        playLight =
          quiet || Math.abs(mood - playLight) < 0.004 ? mood : lerp(playLight, mood, 1 - Math.exp(-dt * 2.6))
        dirty = true
      }
      const light = Math.min(sky, playLight)

      // The shadows move in a few steps, like the frames of a drawn sunrise. With less motion
      // asked for they hold still, cast by the day's sun.
      const shade = quiet ? 6 : Math.round(light * 6)
      // The shadow map is what costs most, so the coarser print gives it up first: the key's reach
      // is then worked out block by block, and only when the light moves.
      const mapped = coarse === 0
      if (shade !== shadedAt || (!mapped && bitsAt !== shade)) {
        const from = trace ? performance.now() : 0
        if (!mapped) {
          relight(world, mesh, keyAt(shade / 6), -1)
          renderer.relight(mesh.data)
          bitsAt = shade
        }
        if (trace) spent.relight += performance.now() - from
        shadedAt = shade
        dirty = true
      }

      // The house's lamps: on while the server wakes, and whenever the chosen way to play is
      // seen by little light.
      groups[HOME] = Math.max(home, clamp((0.78 - playLight) * 3))
      groups[LIT] = 1
      // The cellar's own light, on while the page is at the ledger.
      const cellarTo = act === 'ledger' ? 1 : 0
      const cellarNow = lamps[CELLAR] ?? 0
      if (cellarNow !== cellarTo) {
        const step = quiet ? 1 : dt / 0.45
        lamps[CELLAR] =
          cellarNow < cellarTo ? Math.min(cellarTo, cellarNow + step) : Math.max(cellarTo, cellarNow - step)
        dirty = true
      }
      groups[CELLAR] = lamps[CELLAR] ?? 0
      for (const spec of ROOMS) {
        const index = groupOf(spec.key)
        // A demonstration may turn the lamps of the room the page is on low, but never out: what
        // stands in it is the scene, and a scene in the dark shows nothing.
        const said = now.glow[spec.key]
        const target =
          said === undefined ? (room === spec.key ? 1 : 0) : room === spec.key ? Math.max(0.3, said) : said
        const current = lamps[index] ?? 0
        if (current !== target) {
          const step = quiet ? 1 : dt / 0.6
          lamps[index] =
            current < target ? Math.min(target, current + step) : Math.max(target, current - step)
          dirty = true
        }
        // The glow prints in over 0.6 s, eased in and out: its dots are added in the dither's own
        // order, a dissolve and not a fade.
        groups[index] = inOut(lamps[index] ?? 0)
      }
      // The other worlds wake and sleep in their own time, a few at once.
      COHORTS.forEach((group, index) => {
        const level = clamp(0.5 + 2.2 * Math.sin(clock / 2600 + index * 2.4))
        groups[group] = quiet ? 1 - index : Math.round(level * 3) / 3
      })

      // What was dug is put back after a while, oldest first, and grows into its place; the
      // chunk says where it came from, once for each bout of digging. A hole somebody has come
      // to is put back at once: nobody walks on nothing.
      let urgent = false
      for (const hole of holes)
        if (hole.until > time && ground.has(hole.taken.x, hole.taken.y, hole.taken.z)) {
          hole.until = time - 1
          urgent = true
        }
      if (urgent) holes.sort((a, b) => a.until - b.until)
      const sun = keyAt(shade / 6)
      while (holes[0] && time > holes[0].until) {
        const hole = holes.shift()
        if (!hole) break
        const { x, y, z } = hole.taken
        world.put(hole.taken)
        if (quiet) mesh.around(x, y, z, sun)
        else {
          // It grows from nothing, so the hole's own walls stay drawn round it until it is whole.
          mesh.refresh(x, y, z, sun)
          mesh.scale(x, y, z, 0)
          growing.push({ taken: hole.taken, born: time, size: 0 })
        }
        renderer.setWorld(mesh, world)
        if (time - grewAt > 5000) stage.say(SAYS.back)
        grewAt = time
        aimed = true
        dirty = true
      }
      if (growing.length > 0) {
        // A block grows in a few steps, the way one pops into the game, so most frames change
        // nothing: only a step is sent and drawn, and only a block come whole (its neighbours
        // close up) sends the places again.
        let stepped = false
        let whole = false
        for (const grow of growing) {
          const through = clamp((time - grow.born) / GROWS_FOR)
          const { x, y, z } = grow.taken
          if (through >= 1) {
            mesh.around(x, y, z, sun)
            whole = true
            continue
          }
          const size = Math.min(1, Math.round(through * 1.15 * 5) / 5)
          if (size === grow.size) continue
          grow.size = size
          mesh.scale(x, y, z, size)
          stepped = true
        }
        growing = growing.filter((grow) => time - grow.born < GROWS_FOR)
        if (whole) renderer.setWorld(mesh, world)
        else if (stepped) renderer.relight(mesh.data)
        if (whole || stepped) dirty = true
      }
      if (pieces.length > 0) {
        pieces = pieces.filter((piece) => time / 1000 - piece.born < PIECES_FOR)
        dirty = true
      }
      if (knocked && time > knocked.until) {
        knocked = null
        dirty = true
      }

      const aspect = renderer.width / renderer.height
      const posed: Pose = { ...here, az: here.az + lean.az, el: clamp(here.el + lean.el, -4, 86) }
      const lens = cameraOf(posed, aspect, MIDDLE, here.crowd > 0.004 ? AROUND_ALL : AROUND)
      camera = lens
      /** Where a place in the world is drawn, in screen pixels from the canvas's top left. */
      const drawn = (at: readonly [number, number, number]): [number, number] | null => {
        const spot = project(lens, at)
        return spot ? [spot[0] * renderer.width * unit, spot[1] * renderer.height * unit] : null
      }
      if (aimed) aim()

      // Some things keep moving on their own, a few frames a second, like a drawn loop: the pond
      // while the surface is in view, whoever is about in the room the page is on, and the lights
      // of the other worlds while they can be seen.
      const grass = project(lens, [SIZE / 2, 0, SIZE / 2])
      surfaceSeen = grass !== null && grass[1] > -0.3 && grass[1] < 1.3
      surfaceNear = surfaceSeen && here.span < 80
      roomSeen = here.span < 40
      const alive = surfaceNear || here.crowd > 0.004
      // In step with the shader's own clock (nine ticks a second), so every tick is on screen for
      // the same time and the loop doesn't stutter against it.
      const tick = Math.floor((clock / 1000) * 9)
      if (!quiet && !paused && alive && tick !== ambient) {
        ambient = tick
        dirty = true
      }

      if (!dirty) return
      dirty = false
      drewAt = time
      // The sky's own colour follows the day through one variable. It is written on the sky and
      // nowhere else, since writing it restyles everything under what it is written on, and it
      // moves in steps like the shadows do: a couple of dozen writes for a sunrise, not one a frame.
      const dayNow = (Math.round(day * 24) / 24).toFixed(3)
      if (dayNow !== dayWas) {
        for (const sky of skies) sky.style.setProperty('--day', dayNow)
        dayWas = dayNow
      }
      renderer.setMoving(actors(time / 1000))
      // While anybody up there is on the move the drawing keeps up with them, frame for frame.
      if ((castBusy && !quiet && !paused) || !renderer.lit) dirty = true

      // Of the chunk's hundred and forty layers, only the ones the camera can see are drawn: the
      // four upright edges of the chunk are followed down the screen to find which those are.
      let low = TOP
      let high = BOTTOM
      for (let y = BOTTOM; y <= TOP; y += 3) {
        for (let corner = 0; corner < 4; corner++) {
          const row = rowOf(lens, corner & 1 ? SIZE : 0, y, corner & 2 ? SIZE : 0)
          // (Behind the camera it is NaN, which is neither.)
          if (!(row >= -0.12 && row <= 1.12)) continue
          if (y < low) low = y
          if (y > high) high = y
        }
      }
      const runs = low > high ? mesh.between(BOTTOM, TOP) : mesh.between(low - 4, high + 4)

      // Of the far worlds, only the ones the camera can see (fleet.ts).
      if (here.crowd > 0.004 && fleet) farRunsOf(fleet, lens, here.crowd, farRuns, farSeen)
      else farRuns.length = 0

      // The print changes palette on the rows where the ground behind it changes: the ground at
      // the top of the canvas, then each change below it. As a band, the whole print takes one
      // palette: that of the stratum passing its lower edge.
      const edges: [number, number, number, number] = [1e6, 1e6, 1e6, 1e6]
      const regions: [number, number, number, number, number] = [1, 1, 1, 1, 1]
      const line = window.scrollY + (narrow.matches ? box.bottom : box.top)
      const first = Math.max(
        0,
        layers.findLastIndex((layer) => layer.top <= line),
      )
      regions.fill(bandOf(layers[first]?.tone ?? 'night'))
      if (narrow.matches && spine) {
        const under = layers[first]?.tone ?? 'night'
        if (spine.dataset.tone !== under) spine.dataset.tone = under
      } else {
        if (spine?.dataset.tone) delete spine.dataset.tone
        let changes = 0
        for (let i = first + 1; i < layers.length && changes < 4; i++) {
          const band = bandOf((layers[i] as (typeof layers)[number]).tone)
          if (band === regions[changes]) continue
          edges[changes] = ((layers[i] as (typeof layers)[number]).top - line) / unit
          changes += 1
          regions.fill(band, changes)
        }
      }

      // A label pinned to a room sits at the outer edge of the room's opening. As a band there is
      // no room for them on the drawing, and the page lays them out itself.
      for (const pin of pins) {
        // A label whose scene is off the screen is left as it is: nobody can see where it sits.
        if (pin.bottom <= window.scrollY || pin.top >= window.scrollY + window.innerHeight) continue
        const spot = narrow.matches ? null : drawn(roomPlace(pin.room, 0, 7.2, 3))
        // A room the camera isn't showing has no place on the picture: its name stays at its
        // scene's own corner, so a keyboard that tabs back to it brings the scene up.
        const shown =
          spot !== null && spot[0] >= 0 && spot[0] <= box.width && spot[1] >= 0 && spot[1] <= box.height
        const place = shown ? `${Math.round(spot[0])}px ${Math.round(spot[1])}px` : ''
        if (pin.element.style.translate !== place) {
          pin.element.style.translate = place
          pin.element.toggleAttribute('data-away', !shown && !narrow.matches)
        }
      }

      const plainer = act === 'play' && choice.get().play === 'smooth'
      // The light of a torch somebody is carrying: nothing by day, a pool of it by night.
      const glowing =
        !cast.torch || !surfaceSeen
          ? 0
          : act === 'play'
            ? clamp((0.9 - playLight) * 2.2)
            : act === 'knock'
              ? 1 - dawnOf(day)
              : 0
      // The light of the moment: a carried torch, the vault's server, a room's server, or the
      // lamp by the door, which lights the door warm whenever it is night on the grass.
      const carried = torchOf(torchLight, {
        torch: cast.torch,
        glowing,
        glow: cast.glow,
        vault: lamps[CELLAR] ?? 0,
        lamp: room && roomSeen ? cast.lamp : null,
        night: surfaceSeen ? 1 - light : 0,
      })
      // The light and the tone curve: by the day, and eased with the camera into a room and out.
      const look = lookAt(light, here.under, here.bright, here.inside)
      // The hero's sky is the one colour of the print that changes: night to paper with the day.
      if (skyFor !== dayNow) {
        bands[0] = { low: INK, high: mix(NIGHT, PAPER, dawnOf(day)), line: INK }
        skyFor = dayNow
      }
      renderer.draw({
        camera: lens.matrix,
        shift: lens.shift,
        key: keyAt(shade / 6),
        ...look,
        shadows: mapped ? { middle: SHADED, radius: 16, runs: mesh.between(-8, TOP) } : null,
        exposure: look.exposure * (Number(trying.get('ex')) || 1),
        contrast: Number(trying.get('ct')) || look.contrast,
        // The smoother way to play is drawn plainer and flatter: two greys, no grain.
        levels: plainer ? 2 : 0,
        // Stars are single dots of paper in a night sky, there or not, never fading.
        stars: dawnOf(day) < 0.35,
        star: PAPER,
        unit,
        detail: plainer ? 0 : 1,
        rock: Number(trying.get('rock')) || 0,
        groups,
        bands,
        edges,
        regions,
        warm: TORCH,
        // A torch somebody carries lights the grass round them, the more the darker it is.
        torch: carried,
        // Water and leaves move by this clock; with less motion asked for it stands still.
        time: quiet ? 0 : clock / 1000,
        // The block a click would dig is marked the way the game marks one; a kept block only
        // shows itself for the moment after it is knocked on.
        pick: knocked?.cell ?? (aiming === 'dig' ? (picked?.cell ?? null) : null),
        runs,
        farRuns,
        eye: lens.eye,
        fog: [lens.distance * 0.92, lens.distance * 0.9],
        // Under the grass, what is further than the room fades toward the ground, so depth reads.
        worldFog: here.under * 0.7,
        crowd: here.crowd,
      })
      if (trace) {
        if (trace.length > 6000) trace.splice(0, 2000)
        trace.push([
          time,
          performance.now() - began,
          here.x,
          here.y,
          here.z,
          here.az + lean.az,
          here.el + lean.el,
          Math.log(here.span),
          here.side,
          here.drop,
          here.crowd,
          window.scrollY,
          unit,
          spent.relight,
          farRuns.reduce((sum, run) => sum + run[1], 0),
          runs.reduce((sum, run) => sum + run[1], 0),
          spent.measures,
          spent.dom,
        ])
        spent.relight = 0
        spent.measures = 0
        spent.dom = 0
      }
    }

    const wake = () => {
      dirty = true
    }
    const scrolled = () => {
      moved = true
      dirty = true
    }
    const pointed = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return
      pointer = { x: event.clientX, y: event.clientY }
      leanTo = {
        az: (0.5 - event.clientX / window.innerWidth) * 7,
        el: (event.clientY / window.innerHeight - 0.5) * 4,
      }
      aimed = true
    }
    const left = () => {
      pointer = null
      leanTo = { az: 0, el: 0 }
      aimed = true
    }
    const pressed = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || !picked) return
      // The press is the pickaxe's; it shouldn't also start selecting the words nearby.
      event.preventDefault()
      strike(performance.now())
    }
    // The drawing context can be taken away (a phone with the page in the background, a busy
    // graphics card) and given back with nothing in it, or not at all: the chunk is drawn again on
    // a new canvas when it comes back, or when it hasn't come back soon (start.ts).
    let lostFor = 0
    const gone = (event: Event) => {
      event.preventDefault()
      lost = true
      lostFor = window.setTimeout(() => renew(false), RESTORED_WITHIN_MS)
    }
    const back = () => renew(false)
    measure()
    raf = requestAnimationFrame(frame)
    const unsubscribe = stage.subscribe(wake)
    const unchoose = choice.subscribe(wake)
    canvas.addEventListener('webglcontextlost', gone)
    canvas.addEventListener('webglcontextrestored', back)
    window.addEventListener('scroll', scrolled, { passive: true })
    window.addEventListener('resize', measure)
    narrow.addEventListener('change', refleet)
    window.addEventListener('pointermove', pointed, { passive: true })
    window.addEventListener('pointerdown', pressed)
    document.documentElement.addEventListener('pointerleave', left)
    const sized = new ResizeObserver(measure)
    sized.observe(canvas)
    sized.observe(root)
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true
      dirty = true
    })
    seen.observe(canvas)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(lostFor)
      clearTimeout(gathering)
      unsubscribe()
      unchoose()
      canvas.removeEventListener('webglcontextlost', gone)
      canvas.removeEventListener('webglcontextrestored', back)
      window.removeEventListener('scroll', scrolled)
      window.removeEventListener('resize', measure)
      narrow.removeEventListener('change', refleet)
      window.removeEventListener('pointermove', pointed)
      window.removeEventListener('pointerdown', pressed)
      document.documentElement.removeEventListener('pointerleave', left)
      sized.disconnect()
      seen.disconnect()
      stage.set({ aim: null })
      root.removeAttribute('data-skyless')
      // The chunk outlives this canvas (it is kept for the next one), so it is left whole:
      // whatever is still dug out is put back, and nothing is left half-grown.
      for (const hole of holes) {
        world.put(hole.taken)
        mesh.around(hole.taken.x, hole.taken.y, hole.taken.z, keyAt(Math.max(0, shadedAt) / 6))
      }
      for (const grow of growing)
        mesh.around(grow.taken.x, grow.taken.y, grow.taken.z, keyAt(Math.max(0, shadedAt) / 6))
      renderer.dispose()
    }
  }, [drawnOn, painted])

  return <canvas key={drawnOn.key} ref={ref} className="bl-chunk" aria-hidden />
}

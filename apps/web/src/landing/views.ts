// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The camera's shots, read off the sections of the page (`data-y`, `data-room`, `data-zoom` and the
 * rest, kit.tsx), and the view the page asks for wherever it is scrolled to: a shot held while the
 * page rests on its section, and a flight between one and the next. Not the camera's weight, which
 * Chunk.tsx gives it, nor its arithmetic (engine/camera.ts).
 */
import type { Pose } from './engine/camera'
import { BOTTOM, ROOMS, type RoomKey, roomCenter, SIZE, SURFACE_Y, TOP } from './engine/chunk'
import { clamp, lerp, ease as smooth } from './engine/curves'
import { stopOf } from './stops'

/** How close the camera stands, by name: the section says which, the screen decides the rest. */
type Zoom = 'far' | 'wide' | 'near' | 'close'

/** What a section asks of the camera while it is read. */
export interface Shot {
  from: number
  to: number
  pose: Pose
  /** How far round the camera walks while the section is read, in degrees. */
  turn: number
  room: RoomKey | null
  /** What the chunk puts on while this section is read: the chosen way to play, or the cellar. */
  act: string | null
}

/** What each distance means: how many blocks fit top to bottom, the lens, and the camera's height. */
type Lens = Record<Zoom, { span: number; fov: number; el: number }>

/** A number from an attribute, or `otherwise` when there is none. */
const numberOr = (value: string | undefined, otherwise: number) =>
  value === undefined || value === '' || Number.isNaN(Number(value)) ? otherwise : Number(value)

/** Where across the screen a section holds what it looks at: a side by name, or a place by number. */
function sideOf(stands: string | undefined, band: boolean): number {
  if (band || stands === 'center') return 0.5
  if (stands === 'left') return 0.23
  return Number(stands) || 0.77
}

/** What a section looks at: its room's middle, or a place over the grass. */
function focusOf(
  element: HTMLElement,
  key: RoomKey | null,
  band: boolean,
): readonly [number, number, number] {
  if (key) return roomCenter(key)
  // The surface sections ask for a view that suits a tall screen; a band wants the house in the
  // middle of it.
  const y = band ? Math.min(Number(element.dataset.y), SURFACE_Y + 6) : Number(element.dataset.y)
  return [numberOr(element.dataset.x, SIZE / 2), y - SURFACE_Y, numberOr(element.dataset.z, SIZE / 2)]
}

/** How many blocks a section's view is tall. */
function spanOf(
  element: HTMLElement,
  key: RoomKey | null,
  band: boolean,
  lens: Lens,
  trying: URLSearchParams,
) {
  const tried = trying.get('span')
  if (key && tried) return Number(tried)
  const zoom = (element.dataset.zoom as Zoom | undefined) ?? 'wide'
  return numberOr(element.dataset.span, lens[zoom].span) * (band && element.dataset.span ? 0.85 : 1)
}

/** The view a section asks for, read off its attributes. */
function poseOf(element: HTMLElement, band: boolean, lens: Lens, trying: URLSearchParams): Pose {
  const key = (element.dataset.room as RoomKey | undefined) ?? null
  const spec = key ? ROOMS.find((candidate) => candidate.key === key) : undefined
  const zoom = (element.dataset.zoom as Zoom | undefined) ?? 'wide'
  const focus = focusOf(element, key, band)
  // A room is looked into through its open wall, from a little to one side of straight on.
  const roomAz = spec?.wall === 'z' ? 24 : 66
  const az = spec ? roomAz : zoom === 'near' ? 52 : 44
  return {
    x: focus[0],
    y: focus[1],
    z: focus[2],
    az: numberOr(element.dataset.az, az),
    el: numberOr(element.dataset.el, lens[zoom].el),
    span: spanOf(element, key, band, lens, trying),
    fov: numberOr(element.dataset.fov, lens[zoom].fov),
    side: sideOf(element.dataset.side, band),
    drop: band ? 0.5 : numberOr(element.dataset.drop, 0.5),
    crowd: numberOr(element.dataset.crowd, 0),
    // The page goes darker only on the way down: the dig's upper rooms are printed by the day on
    // stone, and only what is on the dark grounds below (slate, bedrock) in the room's look, lit
    // by its lamps alone. A room is never darker than the page it is on.
    under: element.dataset.tone === 'slate' || element.dataset.tone === 'bedrock' ? 1 : 0,
    inside: key ? 1 : 0,
    bright: numberOr(element.dataset.bright, 1),
  }
}

/** The shots of every section on the page, in the order the page reaches them. */
export function shotsOf(root: HTMLElement, band: boolean, trying: URLSearchParams): Shot[] {
  const lens: Lens = {
    far: { span: (TOP - BOTTOM) * 1.35, fov: 12, el: 10 },
    wide: { span: band ? 30 : 36, fov: 24, el: 22 },
    near: { span: band ? 20 : 23, fov: 28, el: 14 },
    close: { span: band ? 12 : 17, fov: 36, el: 12 },
  }
  const tall = window.innerHeight
  return [...root.querySelectorAll<HTMLElement>('[data-y]')]
    .map((element): Shot => {
      const box = element.getBoundingClientRect()
      const top = box.top + window.scrollY
      // On a wide screen a section holds its view for as long as the page rests on it (from
      // the scroll position that shows its beginning to the one that shows its end), and the
      // camera flies for the whole of the ride from one section to the next. As a band the
      // page isn't steered: a section holds its view while it crosses a line low on the
      // screen, and the camera crosses in the gap between two sections.
      const ease = Math.min(box.height * 0.25, tall * 0.12)
      const stop = band
        ? { start: top + ease - tall * 0.66, end: top + box.height - ease - tall * 0.66 }
        : stopOf(element, tall)
      return {
        from: stop.start,
        to: stop.end,
        pose: poseOf(element, band, lens, trying),
        turn: numberOr(element.dataset.turn, element.dataset.zoom === 'far' ? 30 : 10),
        room: (element.dataset.room as RoomKey | undefined) ?? null,
        act: element.dataset.act ?? null,
      }
    })
    .sort((a, b) => a.from - b.from)
}

/** What the page asks of the camera: a view, and the room and act it is about. */
interface Wanted {
  view: Pose
  room: RoomKey | null
  act: string | null
}

/**
 * Part-way from one view to the next, `t` 0 to 1, evenly with the scroll: a ride already gathers
 * speed and sheds it, and the camera's own weight rounds off the rest. Easing it again here would
 * bunch the whole flight into the middle of the ride. Going from one place to another the camera
 * steps back on the way, the way you would to see where you are going: out and in again along a
 * curve with no corner at either end. On a long ride past many sections it doesn't, or it would
 * bob at every one.
 */
function flight(a: Pose, b: Pose, t: number, scrollSpeed: number): Pose {
  const bump = Math.sin(Math.PI * t) ** 2
  const hop = a.span < 60 && b.span < 60 ? 0.36 * clamp(3 - scrollSpeed / 3) : 0
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
    az: lerp(a.az, b.az, t),
    el: lerp(a.el, b.el, t) + hop * 14 * bump,
    span: Math.exp(lerp(Math.log(a.span), Math.log(b.span), t) + hop * bump),
    fov: lerp(a.fov, b.fov, t),
    side: lerp(a.side, b.side, t),
    drop: lerp(a.drop, b.drop, t),
    crowd: lerp(a.crowd, b.crowd, t),
    under: lerp(a.under, b.under, t),
    inside: lerp(a.inside, b.inside, t),
    bright: lerp(a.bright, b.bright, t),
  }
}

/** The view the page asks for where it is scrolled to, and the room and act it is about. */
export function director(still: MediaQueryList) {
  /** A shot's view when the page is `through` of the way past its section, 0 to 1. */
  const held = (shot: Shot, through: number): Pose => ({
    ...shot.pose,
    // The walk round a section's subject slows to a stop at each end of the section, so it
    // joins the flight to the next one without a jolt. With less motion asked for it stays put.
    az: shot.pose.az + (still.matches ? 0 : shot.turn * (smooth(through) - 0.5)),
  })
  const at = (shot: Shot, view: Pose): Wanted => ({ view, room: shot.room, act: shot.act })

  /** Between two shots, `t` of the way: in flight, or with less motion asked for, at the nearer. */
  const between = (here: Shot, next: Shot, walk: number, t: number, scrollSpeed: number): Wanted => {
    const a = held(here, walk)
    const b = held(next, 0)
    if (still.matches) return t < 0.5 ? at(here, a) : at(next, b)
    return at(t < 0.5 ? here : next, flight(a, b, t, scrollSpeed))
  }

  return (shots: Shot[], goal: Pose, scrollSpeed: number): Wanted => {
    // Each shot is held between two scroll positions, and the camera flies in between.
    const middle = window.scrollY
    const first = shots[0]
    if (!first) return { view: goal, room: null, act: null }
    if (middle <= first.from) return at(first, held(first, 0))
    for (let i = 0; i < shots.length; i++) {
      const here = shots[i] as Shot
      const next = shots[i + 1]
      // A section is walked round as it is scrolled, so one with little scroll of its own is
      // walked round little, and one that fits the screen not at all: it is seen from where its
      // walk begins, at rest and at either end of a flight. Otherwise pushing off from it,
      // landing on it from below, or a pixel of scroll past the last one swings the camera.
      const walk = clamp((here.to - here.from) / (window.innerHeight * 0.25))
      if (middle <= here.to || !next)
        return at(here, held(here, walk * clamp((middle - here.from) / Math.max(1, here.to - here.from))))
      if (middle < next.from)
        return between(here, next, walk, (middle - here.to) / Math.max(1, next.from - here.to), scrollSpeed)
    }
    return at(first, held(first, 0))
  }
}

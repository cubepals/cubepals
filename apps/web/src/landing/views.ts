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

export function shotsOf(root: HTMLElement, band: boolean, trying: URLSearchParams): Shot[] {
  const lens: Record<Zoom, { span: number; fov: number; el: number }> = {
    far: { span: (TOP - BOTTOM) * 1.18, fov: 12, el: 10 },
    wide: { span: band ? 30 : 36, fov: 24, el: 22 },
    near: { span: band ? 20 : 23, fov: 28, el: 14 },
    close: { span: band ? 12 : 17, fov: 36, el: 12 },
  }
  const tall = window.innerHeight
  const number = (value: string | undefined, otherwise: number) =>
    value === undefined || value === '' || Number.isNaN(Number(value)) ? otherwise : Number(value)
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
      const stop = stopOf(element, tall)
      const key = (element.dataset.room as RoomKey | undefined) ?? null
      const spec = key ? ROOMS.find((candidate) => candidate.key === key) : undefined
      // The surface sections ask for a view that suits a tall screen; a band wants the house
      // in the middle of it.
      const y = band ? Math.min(Number(element.dataset.y), SURFACE_Y + 6) : Number(element.dataset.y)
      const focus = key
        ? roomCenter(key)
        : ([number(element.dataset.x, SIZE / 2), y - SURFACE_Y, number(element.dataset.z, SIZE / 2)] as const)
      const zoom = (element.dataset.zoom as Zoom | undefined) ?? 'wide'
      const stands = element.dataset.side
      // A room is looked into through its open wall, from a little to one side of straight on.
      const az = spec ? (spec.wall === 'z' ? 24 : 66) : zoom === 'near' ? 52 : 44
      return {
        from: band ? top + ease - tall * 0.66 : stop.start,
        to: band ? top + box.height - ease - tall * 0.66 : stop.end,
        pose: {
          x: focus[0],
          y: focus[1],
          z: focus[2],
          az: number(element.dataset.az, az),
          el: number(element.dataset.el, lens[zoom].el),
          span:
            key && trying.get('span')
              ? Number(trying.get('span'))
              : number(element.dataset.span, lens[zoom].span) * (band && element.dataset.span ? 0.85 : 1),
          fov: number(element.dataset.fov, lens[zoom].fov),
          // A side by name, or a place across the screen by number.
          side: band ? 0.5 : stands === 'left' ? 0.23 : stands === 'center' ? 0.5 : Number(stands) || 0.77,
          drop: band ? 0.5 : number(element.dataset.drop, 0.5),
          crowd: number(element.dataset.crowd, 0),
        },
        turn: number(element.dataset.turn, zoom === 'far' ? 30 : 10),
        room: key,
        act: element.dataset.act ?? null,
      }
    })
    .sort((a, b) => a.from - b.from)
}

export function director(still: MediaQueryList) {
  /** A shot's view when the page is `through` of the way past its section, 0 to 1. */
  const held = (shot: Shot, through: number): Pose => ({
    ...shot.pose,
    // The walk round a section's subject slows to a stop at each end of the section, so it
    // joins the flight to the next one without a jolt. With less motion asked for it stays put.
    az: shot.pose.az + (still.matches ? 0 : shot.turn * (smooth(through) - 0.5)),
  })

  /** The view the page is asking for where it is scrolled to, and the room it is about. */
  const wanted = (
    shots: Shot[],
    goal: Pose,
    scrollSpeed: number,
  ): { view: Pose; room: RoomKey | null; act: string | null } => {
    // Each shot is held between two scroll positions, and the camera flies in between.
    const middle = window.scrollY
    const first = shots[0]
    if (!first) return { view: goal, room: null, act: null }
    if (middle <= first.from) return { view: held(first, 0), room: first.room, act: first.act }
    for (let i = 0; i < shots.length; i++) {
      const here = shots[i] as Shot
      const next = shots[i + 1]
      // A section is walked round as it is scrolled, so one with little scroll of its own is
      // walked round little, and one that fits the screen not at all: it is seen from where its
      // walk begins, at rest and at either end of a flight. Otherwise pushing off from it,
      // landing on it from below, or a pixel of scroll past the last one swings the camera.
      const walk = clamp((here.to - here.from) / (window.innerHeight * 0.25))
      if (middle <= here.to || !next)
        return {
          view: held(here, walk * clamp((middle - here.from) / Math.max(1, here.to - here.from))),
          room: here.room,
          act: here.act,
        }
      if (middle < next.from) {
        const t = (middle - here.to) / Math.max(1, next.from - here.to)
        // With less motion asked for there is no flight to be half-way through: the camera is
        // at one place or the other, whichever is nearer.
        if (still.matches)
          return t < 0.5
            ? { view: held(here, walk), room: here.room, act: here.act }
            : { view: held(next, 0), room: next.room, act: next.act }
        // Evenly with the scroll: a ride already gathers speed and sheds it, and the camera's
        // own weight rounds off the rest. Easing it again here would bunch the whole flight
        // into the middle of the ride.
        const eased = t
        const a = held(here, walk)
        const b = held(next, 0)
        // Going from one place to another the camera steps back on the way, the way you would
        // to see where you are going: out and in again along a curve with no corner at either
        // end. On a long ride past many sections it doesn't, or it would bob at every one.
        const bump = Math.sin(Math.PI * t) ** 2
        const hop = a.span < 60 && b.span < 60 ? 0.36 * clamp(3 - scrollSpeed / 3) : 0
        return {
          view: {
            x: lerp(a.x, b.x, eased),
            y: lerp(a.y, b.y, eased),
            z: lerp(a.z, b.z, eased),
            az: lerp(a.az, b.az, eased),
            el: lerp(a.el, b.el, eased) + hop * 14 * bump,
            span: Math.exp(lerp(Math.log(a.span), Math.log(b.span), eased) + hop * bump),
            fov: lerp(a.fov, b.fov, eased),
            side: lerp(a.side, b.side, eased),
            drop: lerp(a.drop, b.drop, eased),
            crowd: lerp(a.crowd, b.crowd, eased),
          },
          room: t < 0.5 ? here.room : next.room,
          act: t < 0.5 ? here.act : next.act,
        }
      }
    }
    return { view: held(first, 0), room: first.room, act: first.act }
  }
  return wanted
}

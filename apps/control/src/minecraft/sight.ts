// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a player sees of a label: where its plate falls on their screen from where they stand and
 * the way they look, as the game projects it. The game's camera has a vertical field of view
 * (`fov`) and puts the screen's middle where the player looks (measured in a 26.2 client,
 * `docs/minecraft/readable-text.md`); a label's plate is its words and the room round them
 * (`plateOf`). A flat label faces its way; one that turns faces the player across, upright. Not
 * where labels go, which the rules in `readable.ts` decide.
 */
import { type Facing, type Label, YAW } from './arcade/datapack.ts'
import { plateOf } from './arcade/label-space.ts'

export type Point = readonly [number, number, number]

/** Where a player stands and looks: their eye, and the game's yaw and pitch, in degrees. */
export interface View {
  eye: Point
  /** 0 looks south, 90 west, 180 north, -90 east. */
  yaw: number
  /** Up is less than 0; 0 is level. */
  pitch: number
}

/** A screen: its size in pixels and the camera's vertical field of view, in degrees. */
export interface Screen {
  width: number
  height: number
  fov: number
}

/** Where on a screen something falls, in pixels from its top left. */
export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const radians = (degrees: number) => (degrees * Math.PI) / 180
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const minus = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/** The way a yaw looks, level, and the way to its right. */
function across(yaw: number): { ahead: Point; right: Point } {
  const r = radians(yaw)
  return { ahead: [-Math.sin(r), 0, Math.cos(r)], right: [-Math.cos(r), 0, -Math.sin(r)] }
}

/** A plate's four corners in the world, as a player at `eye` sees it: a turning one faces them. */
export function cornersOf(label: Label, eye: Point): Point[] {
  const { left, right, bottom, top } = plateOf(label)
  const [x, y, z] = label.at
  // The way along the plate, from its reader's left to their right.
  const along: Point =
    label.facing === undefined
      ? (() => {
          const to = minus(eye, label.at)
          const level = Math.hypot(to[0], to[2]) || 1
          return [-to[2] / level, 0, to[0] / level]
        })()
      : across(YAW[label.facing as Facing]).right
  const at = (side: number, up: number): Point => [x + along[0] * side, y + up, z + along[2] * side]
  return [at(left, top), at(right, top), at(right, bottom), at(left, bottom)]
}

/** Where a label's plate falls on a screen, or null if any of it is behind the player. */
export const seen = (label: Label, view: View, screen: Screen): Rect | null =>
  seenPoints(cornersOf(label, view.eye), view, screen)

/** Where a box, a sign or a block, falls on a screen, from its least corner to its greatest; null if any of it is behind. */
export function seenBox(from: Point, to: Point, view: View, screen: Screen): Rect | null {
  const corners: Point[] = []
  for (const x of [from[0], to[0]])
    for (const y of [from[1], to[1]]) for (const z of [from[2], to[2]]) corners.push([x, y, z])
  return seenPoints(corners, view, screen)
}

/** Where points fall on a screen, as the box round them, or null if any is behind the player. */
function seenPoints(corners: readonly Point[], view: View, screen: Screen): Rect | null {
  const { ahead: level, right } = across(view.yaw)
  const p = radians(view.pitch)
  const ahead: Point = [level[0] * Math.cos(p), -Math.sin(p), level[2] * Math.cos(p)]
  const up: Point = [level[0] * Math.sin(p), Math.cos(p), level[2] * Math.sin(p)]
  const focal = screen.height / 2 / Math.tan(radians(screen.fov) / 2)
  const points = corners.map((corner) => {
    const v = minus(corner, view.eye)
    const depth = dot(v, ahead)
    return depth <= 0
      ? null
      : [screen.width / 2 + (focal * dot(v, right)) / depth, screen.height / 2 - (focal * dot(v, up)) / depth]
  })
  if (points.some((point) => point === null)) return null
  const xs = points.map((point) => point?.[0] ?? 0)
  const ys = points.map((point) => point?.[1] ?? 0)
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

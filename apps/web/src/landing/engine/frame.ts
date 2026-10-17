// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What the renderer (gl.ts) is handed: a frame's camera, light, look and inks, and the packed
 * blocks and parts it draws. Only the shapes; the drawing is gl.ts's.
 */
import type { Vec3 } from './camera'
import type { Rgb } from './light'

/** The colours of a print: the dark dot, the light dot and the line. */
export interface Palette {
  low: Rgb
  high: Rgb
  line: Rgb
}

/** What one frame needs to know. Colours are 0–1 RGB. */
export interface Frame {
  /** The camera: world to clip space, column-major, as WebGL takes it. */
  camera: Float32Array
  /** How far the whole picture is slid across and up the screen, in half-screens. */
  shift: readonly [number, number]
  /** The way toward the key light (the moon or the sun), and how strong it is. */
  key: Vec3
  keyLight: number
  /** How much light the sky fills in where the key doesn't reach. */
  fill: number
  /**
   * The shadow map: the sphere it covers, and which of the world's blocks cast into it. Null
   * where a face's own bits say what the key reaches instead (a device that can't afford it).
   */
  shadows: { middle: Vec3; radius: number; runs: readonly (readonly [number, number])[] } | null
  /** The tone curve the print goes through before it is dithered. */
  exposure: number
  contrast: number
  /** A few flat steps of grey in place of the curve's own (the plainer print), or 0. */
  levels: number
  /** How much of each material's own grain is drawn, 0 to 1. */
  detail: number
  /** How far the rock under the grass is lifted toward bare paper, 0 to 1. */
  rock?: number
  /** How bright each light switch is, 0–1: sixteen of them. Switch 0 is unused. */
  groups: ArrayLike<number>
  /** The palettes a print can be in: the sky, the light ground, the dark ground, the night. */
  bands: readonly [Palette, Palette, Palette, Palette]
  /**
   * The drawn rows, counted from the top, where the page behind changes colour (four of them,
   * rising; the ones not needed are far below the picture), and which palette each of the five
   * stretches they make is printed in.
   */
  edges: readonly [number, number, number, number]
  regions: readonly [number, number, number, number, number]
  warm: Rgb
  /** Whether the empty night sky gets its stars, and their colour. */
  stars: boolean
  star: Rgb
  /** How many CSS pixels one drawn dot is. */
  unit: number
  /**
   * A light that isn't part of the world (a torch somebody carries, the server's own glow): where
   * it is, how far it reaches, how bright, and whose it is (1 out of doors, or a room's switch).
   */
  torch: readonly [number, number, number, number, number, number] | null
  /** How much light a room has of its own, and how strongly its lamps light it. */
  roomFill: number
  lampGain: number
  /** How far the camera is under the grass, 0 to 1: the rock outside the rooms goes dark with it. */
  deep: number
  /** The least light any face gets, from everything round about. */
  ambient: number
  /** How many times over a room's lamps count: more when the room is a lit window seen from outside. */
  windows: number
  time: number
  /** The block the cursor is on, or null. */
  pick: readonly [number, number, number] | null
  /**
   * Which of the world's blocks to draw, as runs of the packed list (first block, how many): the
   * layers the camera can see, and whatever digging has uncovered since.
   */
  runs: readonly (readonly [number, number])[]
  /**
   * Which of the far worlds' faces to draw, as runs of their packed list: the first, how many, and
   * which of the five faces kept they are (0 to 4).
   */
  farRuns: readonly (readonly [number, number, number])[]
  /** Where the camera's eye is, and how far off the far worlds start to fade and are gone by. */
  eye: readonly [number, number, number]
  fog: readonly [number, number]
  /** How much this world itself fades with distance, 0 to 1: depth, under the grass. */
  worldFog?: number
  /** How much of the other worlds is there, 0 to 1: they spread outward from this one. */
  crowd: number
}

export interface Packed {
  positions: Float32Array
  data: Uint8Array
  count: number
  /** For loose parts only: how each is turned about its middle, two angles a part (round, tipped). */
  turns?: Float32Array
  /** For the world's blocks: each face's four corners, two bits each, six bytes in eight a block. */
  ao?: Uint8Array
}

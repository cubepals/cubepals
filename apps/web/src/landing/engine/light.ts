// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * How the chunk is lit and printed at a moment: where the key light comes from (the moon by night,
 * the sun by day), how strong it and the sky's fill are, and the tone curve the print goes through,
 * by how far the day has come and whether the camera is out on the grass or in a room. The film
 * (Chunk.tsx) and the phone's pictures (phone/printer.ts) both read it, so they print alike. Not
 * the drawing itself (gl.ts). Also the inks the print is made in.
 */
import type { Vec3 } from './camera'

export const unit = (v: Vec3): [number, number, number] => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** A colour, 0–1 each of red, green and blue. */
export type Rgb = readonly [number, number, number]

const rgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
]
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

// The print's inks: ink, paper and the night field, as landing.css names them, the stone of the
// dig, and the torch, the one warm colour, which means something is on.
export const INK = rgb('#0d0d0d')
export const PAPER = rgb('#F8F7F5')
export const NIGHT = rgb('#8C86F2')
export const TORCH = rgb('#FFB01F')
const STONE = rgb('#E6E3DC')
/** The dig's dark print: between slate and bedrock, so it is the ground on either; and its line. */
const DARK = rgb('#16161A')
const DARK_LINE = rgb('#3C3C44')
/** The dig's print: light dots on its dark, shadows black. */
export const DIG = { low: DARK, high: STONE, line: DARK_LINE } as const

/**
 * The key light by night and by day, as the way toward it: from the left and behind the house as
 * the camera mostly sees it, so the house reads as a dark mass with its tops and roof steps lit.
 * The moon stands high, so the island's top is a lit floor with short shadows on it, its left face
 * a mid-tone and its right face dark (concept A1's three tones); the sun is lower, for the long
 * shadows of the day.
 */
const MOON: Vec3 = unit([-16, 60, 20])
const SUN: Vec3 = unit([-24, 40, 18])

/** The far worlds are lit by the day's key, from their own bits (fleet.ts). */
export const DAY_KEY: Vec3 = SUN

/**
 * Where the key light comes from as the day turns, `day` 0 (night) to 1: the moon swings over
 * into the sun, so the shadows move with it rather than jumping.
 */
export function keyAt(day: number): [number, number, number] {
  return unit([
    MOON[0] + (SUN[0] - MOON[0]) * day,
    MOON[1] + (SUN[1] - MOON[1]) * day,
    MOON[2] + (SUN[2] - MOON[2]) * day,
  ])
}

/**
 * One look: how strong the key and the sky's fill are, how much light a room has of its own and
 * how strongly its lamps light it, and the tone curve.
 */
interface Look {
  keyLight: number
  fill: number
  roomFill: number
  lampGain: number
  exposure: number
  contrast: number
  /** How far the camera is into a room, which darkens the rock outside it. */
  deep: number
}

/**
 * The three looks the film is printed in. The tone curve is the art direction: each is tuned by
 * eye so that everything in the chunk (the house, the trees, the sheep, people, the lamps) reads
 * at a glance, by its lit edges and its silhouette: a strong key from one side and a low fill, so
 * the faces turned away print nearly ink. Under the grass a room is dim, its walls in dark greys,
 * and its lamps light it.
 */
const MOONLIT: Omit<Look, 'deep'> = {
  keyLight: 2.2,
  fill: 0.55,
  roomFill: 0.45,
  lampGain: 1.2,
  exposure: 0.5,
  contrast: 1.6,
}
const DAYLIT: Omit<Look, 'deep'> = {
  keyLight: 2.8,
  fill: 0.85,
  roomFill: 0.45,
  lampGain: 1.2,
  exposure: 0.42,
  contrast: 1.55,
}
const ROOMLIT: Omit<Look, 'deep'> = {
  keyLight: 2.2,
  fill: 0.55,
  roomFill: 0.24,
  lampGain: 1.3,
  exposure: 1.45,
  contrast: 1.55,
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * The look at a moment: `light` is how far the day has come, 0 to 1; `under` how far the camera is
 * into a room, 0 to 1; `bright` scales the exposure, for a beat that asks for more or less.
 */
export function lookAt(light: number, under: number, bright = 1): Look {
  const at = (key: Exclude<keyof Look, 'deep'>) =>
    lerp(lerp(MOONLIT[key], DAYLIT[key], light), ROOMLIT[key], under)
  return {
    keyLight: at('keyLight'),
    fill: at('fill'),
    roomFill: at('roomFill'),
    lampGain: at('lampGain'),
    exposure: at('exposure') * bright,
    contrast: at('contrast'),
    deep: under,
  }
}

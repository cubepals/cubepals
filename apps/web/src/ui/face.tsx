'use client'

import { useState } from 'react'

/**
 * A player's face: the one on their skin, which Blockly fetches from Mojang and serves itself so
 * no third party learns who plays on whose server. Until it arrives, and for anyone without a skin
 * of their own, a face drawn here stands in, made from the name so the same player always wears
 * the same one.
 */
export function PlayerFace({
  name,
  uuid,
  size = 40,
}: {
  name: string
  /**
   * The UUID the server knows them by. An account's finds their skin; one a server that doesn't
   * check accounts made up from the name finds the skin of the account with that name. Without
   * one, only the stand-in is drawn.
   */
  uuid?: string | undefined
  size?: number
}) {
  const src = faceSource(name, uuid)
  const [seen, setSeen] = useState<{ src: string; state: 'loaded' | 'failed' } | null>(null)
  const state = seen !== null && seen.src === src ? seen.state : 'loading'
  return (
    <span className="bk-face" style={{ width: size, height: size }} aria-hidden>
      <FallbackFace name={name} />
      {src !== null && state !== 'failed' && (
        // biome-ignore lint/performance/noImgElement: an 8×8 face drawn large; there is nothing to optimise
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          decoding="async"
          loading="lazy"
          data-loaded={state === 'loaded' || undefined}
          // A face can load, or fail to, before the page is ready to hear about it.
          ref={(img) => {
            if (img?.complete && state === 'loading')
              setSeen({ src, state: img.naturalWidth > 0 ? 'loaded' : 'failed' })
          }}
          onLoad={() => setSeen({ src, state: 'loaded' })}
          onError={() => setSeen({ src, state: 'failed' })}
        />
      )}
    </span>
  )
}

/** Where a player's face is: by their account, or by name where the server doesn't check accounts. */
function faceSource(name: string, uuid: string | undefined): string | null {
  if (uuid === undefined) return null
  if (isAccountUuid(uuid)) return `/api/public/players/${uuid}/face.png`
  return /^[A-Za-z0-9_]{3,16}$/.test(name) ? `/api/public/names/${name}/face.png` : null
}

/** Mojang issues version 4 UUIDs; a server that doesn't check accounts makes version 3 ones. */
function isAccountUuid(uuid: string): boolean {
  const hex = uuid.replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(hex) && hex[12] === '4'
}

/**
 * The stand-in faces: Blockly's own, not the game's. Each is eight rows of eight pixels, in
 * letters a palette fills: H hair and h its shade, S skin and s its shade, M the mouth, W the whites
 * of the eyes and E the eyes, A an accent (a cap, a band, a hood) and a its shade.
 */
const STYLES: readonly (readonly string[])[] = [
  // Crop
  ['HHHHHHHH', 'HhHHHHhH', 'HSSSSSSH', 'SSSSSSSS', 'SWESSEWS', 'SSSssSSS', 'SSSMMSSS', 'SSSSSSSS'],
  // Fringe
  ['HHHHHHHH', 'HHHhHHHH', 'HHHHHHSH', 'HSSSSSSS', 'SWESSEWS', 'SSSssSSS', 'SSMMMMSS', 'SSSSSSSS'],
  // Long
  ['HHHHHHHH', 'HHHhhHHH', 'HHSSSSHH', 'HSSSSSSH', 'HWESSEWH', 'HSSssSSH', 'HSSMMSSH', 'HHSSSSHH'],
  // Cap
  ['AAAAAAAA', 'AAAaaAAA', 'aaaaaaaa', 'HSSSSSSH', 'SWESSEWS', 'SSSssSSS', 'SSSMMSSS', 'SSSSSSSS'],
  // Beard
  ['HHHHHHHH', 'HhHHHHhH', 'HSSSSSSH', 'SSSSSSSS', 'SWESSEWS', 'SSSssSSS', 'HHSMMSHH', 'hHHHHHHh'],
  // Band
  ['HHHHHHHH', 'HHhHHhHH', 'AAAAAAAA', 'SSSSSSSS', 'SWESSEWS', 'SSSssSSS', 'SSSMMSSS', 'SSSSSSSS'],
  // Hood
  ['AAAAAAAA', 'AaaaaaaA', 'AHHHHHHA', 'ASSSSSSA', 'AWESSEWA', 'ASSssSSA', 'ASSMMSSA', 'AASSSSAA'],
]

/** Skin, its shade and the mouth, light to deep. */
const SKINS: readonly (readonly [string, string, string])[] = [
  ['#f6d7b8', '#e8bf98', '#b9785b'],
  ['#eec39a', '#d9a77c', '#a8664a'],
  ['#d9a066', '#c28a52', '#8a4f33'],
  ['#b87a4b', '#9e653b', '#6b3a25'],
  ['#8d5a3b', '#774a2f', '#4a2718'],
  ['#5e3b27', '#4e301f', '#2a170e'],
]

/** Hair and its shade. */
const HAIR: readonly (readonly [string, string])[] = [
  ['#2b2320', '#1c1614'],
  ['#4a3121', '#3a2618'],
  ['#7a4e2d', '#633f24'],
  ['#a0462a', '#843a22'],
  ['#d9b35f', '#c49b48'],
  ['#b8b2a7', '#9c968b'],
]

const EYES: readonly string[] = ['#5a3a22', '#3b6fb6', '#3f8a4a', '#2a2320', '#8a6a2f']

/** Blockly's own colours, for whatever they wear. */
const ACCENTS: readonly (readonly [string, string])[] = [
  ['#6cc24a', '#4f9e30'],
  ['#2a6349', '#1c4a36'],
  ['#5b9bd5', '#3f7fb8'],
  ['#c2456b', '#9c3354'],
  ['#e8b53a', '#c8952a'],
  ['#8f86d6', '#6f66b8'],
]

const WHITES = '#f4f1ea'

/** The face a name wears: its pixels as colours, row by row. Exported for the design page. */
function fallbackPixels(name: string): string[][] {
  const next = random(name.toLowerCase())
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T
  const style = pick(STYLES)
  const [skin, skinShade, mouth] = pick(SKINS)
  const [hair, hairShade] = pick(HAIR)
  const eyes = pick(EYES)
  const [accent, accentShade] = pick(ACCENTS)
  const colour: Record<string, string> = {
    H: hair,
    h: hairShade,
    S: skin,
    s: skinShade,
    M: mouth,
    W: WHITES,
    E: eyes,
    A: accent,
    a: accentShade,
  }
  return style.map((row) => [...row].map((letter) => colour[letter] ?? skin))
}

function FallbackFace({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden>
      {[...paths(fallbackPixels(name))].map(([fill, d]) => (
        <path key={fill} fill={fill} d={d} />
      ))}
    </svg>
  )
}

/** One path per colour, each row's runs of it a rectangle: a handful of elements, not sixty-four. */
function paths(rows: string[][]): Map<string, string> {
  const out = new Map<string, string>()
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const fill = row[x] as string
      let width = 1
      while (row[x + width] === fill) width++
      out.set(fill, `${out.get(fill) ?? ''}M${x} ${y}h${width}v1h-${width}z`)
      x += width
    }
  })
  return out
}

/** A small seeded generator (FNV-1a into mulberry32): the same name, the same face, everywhere. */
function random(seed: string): () => number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193)
  let state = h >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

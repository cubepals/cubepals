/**
 * A player's face, cut from their skin the way the game draws a head: the front of the head, with
 * the front of the hat over it. A skin is 64×64, or 64×32 from before the game had a second layer
 * for the body; both keep the head in the same place, and a larger one is the same layout at a
 * multiple of the size.
 */

/** Decoded pixels, row by row, four bytes (RGBA) a pixel. */
export interface SkinPixels {
  width: number
  height: number
  rgba: Uint8Array
}

/** A face is eight pixels square. */
export const FACE = 8

const HEAD = { x: 8, y: 8 }
const HAT = { x: 40, y: 8 }
/** The whole of a legacy skin's hat layer, which its transparency rule looks at. */
const LEGACY_HAT_AREA = { x: 32, y: 0, width: 32, height: 16 }

/** The face, 8×8 RGBA and always opaque; null for pixels that are not a skin. */
export function faceOf(skin: SkinPixels): Uint8Array | null {
  const { width, height, rgba } = skin
  if (width < 64 || width % 64 !== 0 || (height !== width && height !== width / 2)) return null
  if (rgba.length !== width * height * 4) return null
  const scale = width / 64
  const at = (x: number, y: number) => (y * scale * width + x * scale) * 4

  // A legacy skin whose hat layer has no transparent pixel at all has none meant: the game draws
  // no hat for it, rather than a box of solid colour over the face.
  const legacy = height === width / 2
  const hat = !legacy || hasTransparency(rgba, LEGACY_HAT_AREA, at)

  const face = new Uint8Array(FACE * FACE * 4)
  for (let y = 0; y < FACE; y++)
    for (let x = 0; x < FACE; x++) {
      const out = (y * FACE + x) * 4
      const base = at(HEAD.x + x, HEAD.y + y)
      // The head itself is drawn opaque whatever its alpha says.
      let r = rgba[base] ?? 0
      let g = rgba[base + 1] ?? 0
      let b = rgba[base + 2] ?? 0
      if (hat) {
        const top = at(HAT.x + x, HAT.y + y)
        const alpha = (rgba[top + 3] ?? 0) / 255
        r = Math.round((rgba[top] ?? 0) * alpha + r * (1 - alpha))
        g = Math.round((rgba[top + 1] ?? 0) * alpha + g * (1 - alpha))
        b = Math.round((rgba[top + 2] ?? 0) * alpha + b * (1 - alpha))
      }
      face[out] = r
      face[out + 1] = g
      face[out + 2] = b
      face[out + 3] = 255
    }
  return face
}

function hasTransparency(
  rgba: Uint8Array,
  area: { x: number; y: number; width: number; height: number },
  at: (x: number, y: number) => number,
): boolean {
  for (let y = area.y; y < area.y + area.height; y++)
    for (let x = area.x; x < area.x + area.width; x++) if ((rgba[at(x, y) + 3] ?? 0) < 128) return true
  return false
}

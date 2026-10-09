import { describe, expect, test } from 'bun:test'
import { isAccountUuid } from './identity.ts'
import { FACE, faceOf, type SkinPixels } from './skin.ts'

type Rgba = readonly [number, number, number, number]

/** A skin of one colour, with the pixels given painted over it. */
function skin(width: number, height: number, paint: (set: (x: number, y: number, c: Rgba) => void) => void) {
  const rgba = new Uint8Array(width * height * 4)
  const set = (x: number, y: number, [r, g, b, a]: Rgba) => rgba.set([r, g, b, a], (y * width + x) * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, [0, 0, 0, 0])
  paint(set)
  return { width, height, rgba } satisfies SkinPixels
}

const pixel = (face: Uint8Array, x: number, y: number) => [
  ...face.slice((y * FACE + x) * 4, (y * FACE + x) * 4 + 4),
]

const SKIN: Rgba = [200, 150, 110, 255]
const HAT: Rgba = [40, 90, 200, 255]

/** The head's front in skin colour, with an eye at (2, 4). */
const head = (set: (x: number, y: number, c: Rgba) => void) => {
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) set(x, y, SKIN)
  set(10, 12, [255, 255, 255, 255])
}

describe('a face from a skin', () => {
  test('the front of the head, as the game draws it', () => {
    const face = faceOf(skin(64, 64, head))
    expect(face?.length).toBe(FACE * FACE * 4)
    expect(pixel(face ?? new Uint8Array(), 0, 0)).toEqual([...SKIN])
    expect(pixel(face ?? new Uint8Array(), 2, 4)).toEqual([255, 255, 255, 255])
  })

  test('the hat is drawn over the head, and where it is see-through the head shows', () => {
    const face = faceOf(
      skin(64, 64, (set) => {
        head(set)
        for (let x = 40; x < 48; x++) set(x, 8, HAT)
        set(40, 9, [0, 0, 0, 128])
      }),
    )
    expect(pixel(face ?? new Uint8Array(), 5, 0)).toEqual([...HAT])
    // Half-transparent black over the skin: half as bright, and the face itself opaque.
    expect(pixel(face ?? new Uint8Array(), 0, 1)).toEqual([100, 75, 55, 255])
    expect(pixel(face ?? new Uint8Array(), 0, 7)).toEqual([...SKIN])
  })

  test('the head is opaque whatever its alpha says', () => {
    const face = faceOf(skin(64, 64, (set) => set(8, 8, [10, 20, 30, 0])))
    expect(pixel(face ?? new Uint8Array(), 0, 0)).toEqual([10, 20, 30, 255])
  })

  test('a legacy skin with a solid hat layer has no hat, as in the game', () => {
    const solid = faceOf(
      skin(64, 32, (set) => {
        head(set)
        for (let y = 0; y < 16; y++) for (let x = 32; x < 64; x++) set(x, y, HAT)
      }),
    )
    expect(pixel(solid ?? new Uint8Array(), 0, 0)).toEqual([...SKIN])

    const worn = faceOf(
      skin(64, 32, (set) => {
        head(set)
        set(40, 8, HAT)
      }),
    )
    expect(pixel(worn ?? new Uint8Array(), 0, 0)).toEqual([...HAT])
  })

  test('a larger skin is the same layout, sampled', () => {
    const face = faceOf(
      skin(128, 128, (set) => {
        for (let y = 16; y < 32; y++) for (let x = 16; x < 32; x++) set(x, y, SKIN)
        set(20, 24, [255, 255, 255, 255])
      }),
    )
    expect(pixel(face ?? new Uint8Array(), 2, 4)).toEqual([255, 255, 255, 255])
    expect(pixel(face ?? new Uint8Array(), 3, 4)).toEqual([...SKIN])
  })

  test('pixels that are not a skin have no face', () => {
    expect(faceOf(skin(32, 32, head))).toBeNull()
    expect(faceOf(skin(64, 48, head))).toBeNull()
    expect(faceOf({ width: 64, height: 64, rgba: new Uint8Array(16) })).toBeNull()
  })
})

describe('whose UUID it is', () => {
  test('an account’s is version 4; one a server made from a name is version 3', () => {
    expect(isAccountUuid('069a79f4-44e9-4726-a5be-fca90e38aaf5')).toBe(true)
    expect(isAccountUuid('069a79f444e94726a5befca90e38aaf5')).toBe(true)
    expect(isAccountUuid('2289dfb4-69e8-34dd-94a2-8862994e2feb')).toBe(false)
    expect(isAccountUuid('not-a-uuid')).toBe(false)
  })
})

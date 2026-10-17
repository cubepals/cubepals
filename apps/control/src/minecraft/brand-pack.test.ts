// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' resource pack, read the way the game reads it: which releases take it, that every
 * model and picture an item names is in it, that it changes nothing but the markers, and how the
 * datapacks show a marker. Its zip and hash are `infra/formats/brand-pack-zip.test.ts`'s.
 */
import { describe, expect, test } from 'bun:test'
import { INDIGO, INK, PAPER } from './arcade/datapack.ts'
import { ARCADE_FILES } from './arcade.ts'
import { type Picture, SIDE } from './brand-art.ts'
import { BRAND_PACK, MARKER_ITEM, MARKERS, RESOURCE_FORMATS } from './brand-pack.ts'
import { EXIT_MARKER, WAITING_FILES } from './duels-waiting.ts'

/**
 * The resource format of each release Cubepals' games run on, as Mojang's jars declare it
 * (`version.json`, `pack_version.resource_major` and `resource_minor`): Duels' 1.21.11, the
 * Arcade's newest releases, and 1.21.4 and 1.21.8, which join the Arcade through Via.
 */
const RELEASE_FORMATS = { '1.21.4': 46, '1.21.8': 64, '1.21.11': 75, '26.2': 88, '26.3': 97.1 }

/** The last format a release reads only `pack_format` and `supported_formats` for: 1.21.8's. */
const BEFORE_RANGES = 64

const json = (path: string) => {
  const file = BRAND_PACK.find((candidate) => candidate.path === path)
  if (file === undefined || !('json' in file)) throw new Error(`${path} is not in the pack`)
  return file.json as Record<string, unknown>
}
const has = (path: string) => BRAND_PACK.some((file) => file.path === path)

/** `cubepals:item/way_out` as the file it names, under `assets/`. */
const assetPath = (id: string, kind: 'models' | 'textures', extension: string) => {
  const [namespace, path] = id.split(':')
  return `assets/${namespace}/${kind}/${path}.${extension}`
}

/** Every alpha a picture has, and the colour of each pixel it draws, as `#RRGGBB`. */
function inked({ rgba }: Picture): { alphas: Set<number>; colours: Set<string> } {
  const alphas = new Set<number>()
  const colours = new Set<string>()
  for (let at = 0; at < rgba.length; at += 4) {
    alphas.add(rgba[at + 3] ?? -1)
    if (rgba[at + 3] === 255)
      colours.add(
        `#${[...rgba.slice(at, at + 3)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`.toUpperCase(),
      )
  }
  return { alphas, colours }
}

describe("Cubepals' resource pack", () => {
  test("every release Cubepals' games run on takes it: its format is in the range the pack names, the way that release reads it", () => {
    const { pack } = json('pack.mcmeta') as {
      pack: { min_format: number; max_format: number; pack_format?: number; supported_formats?: number[] }
    }
    expect(pack.min_format).toBe(RESOURCE_FORMATS.min)
    for (const format of Object.values(RELEASE_FORMATS)) {
      // A 1.21.8 game ignores a pack without `pack_format`, and draws every marker as an oak door.
      const [min, max] =
        format <= BEFORE_RANGES ? (pack.supported_formats ?? []) : [pack.min_format, pack.max_format]
      if (format <= BEFORE_RANGES) expect(pack.pack_format).toBe(min)
      expect(min).toBeLessThanOrEqual(format)
      expect(max).toBeGreaterThanOrEqual(format)
    }
  })

  test('it changes the oak door item alone, and draws it as vanilla does unless it carries a marker', () => {
    const vanilla = BRAND_PACK.filter((file) => file.path.startsWith('assets/minecraft/')).map(
      (file) => file.path,
    )
    expect(vanilla).toEqual([`assets/minecraft/items/${MARKER_ITEM.replace('minecraft:', '')}.json`])
    const { model } = json(vanilla[0] ?? '') as {
      model: {
        property: string
        cases: { when: string; model: { model: string } }[]
        fallback: { model: string }
      }
    }
    expect(model.property).toBe('minecraft:custom_model_data')
    expect(model.fallback.model).toBe('minecraft:item/oak_door')
    expect(model.cases.map((c) => c.when)).toEqual(Object.values(MARKERS))
  })

  test('every model a marker names is in it, and every picture a model names', () => {
    const { model } = json('assets/minecraft/items/oak_door.json') as {
      model: { cases: { model: { model: string } }[] }
    }
    for (const { model: shown } of model.cases) {
      const path = assetPath(shown.model, 'models', 'json')
      const { textures } = json(path) as { textures: Record<string, string> }
      for (const texture of Object.values(textures))
        expect(has(assetPath(texture, 'textures', 'png'))).toBe(true)
    }
  })

  test("its pictures are the brand's two colours and the indigo, whole pixels at twice the game's size", () => {
    for (const file of BRAND_PACK)
      if ('picture' in file) {
        const { width, height } = file.picture
        expect(width).toBe(height)
        if (file.path !== 'pack.png') expect(width).toBe(SIDE)
        const { alphas, colours } = inked(file.picture)
        // Clear round the shape, and solid in it: nothing blended at an edge. The pack's own picture
        // is a whole square of Paper, as Cubepals' servers show the mark.
        expect([...alphas].sort((a, b) => a - b)).toEqual(file.path === 'pack.png' ? [255] : [0, 255])
        expect([...colours].every((colour) => [INK, PAPER, INDIGO].includes(colour))).toBe(true)
        expect(colours.has(INK) && colours.has(PAPER)).toBe(true)
      }
  })

  test('the Arcade and Duels show each marker on an oak door item, which reads as a way through without the pack', () => {
    const commands = [...ARCADE_FILES, ...WAITING_FILES].flatMap((file) => file.content.split('\n'))
    const shown = commands.filter(
      (command) => command.includes('summon minecraft:item_display') && command.includes('cubepals:'),
    )
    // An open door at each passage's end, and one over Duels' way out.
    expect(shown).toHaveLength(2 + 1)
    for (const command of shown) expect(command).toContain(`id:"${MARKER_ITEM}"`)
    expect(commands.find((command) => command.includes('Back to the hub'))).toContain(
      `item_model="${MARKER_ITEM}",custom_model_data={strings:["${MARKERS.backToHub}"]}`,
    )
    expect(EXIT_MARKER.marker).toBe(MARKERS.wayOut)
  })
})

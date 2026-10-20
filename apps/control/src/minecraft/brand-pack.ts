// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' resource pack: the look of the ways in and out on Cubepals' own games, the Arcade and
 * Duels, as one family. Its files are described here, as JSON and pictures (`brand-art.ts`); the
 * zip is put together and hashed where files are written (`infra/formats/brand-pack-zip.ts`), and
 * served by the site. No server offers it as a player joins: the game would hold them out of the
 * world until they answered whether to take it (`runtime-spec.ts`).
 *
 * The pack changes nothing a player sees anywhere else. Every marker is an oak door item, which
 * the games show as an item, never placed, so the pack retextures only an oak door marked with one
 * of its own names (`custom_model_data`), and any other oak door draws as vanilla's. The pack is
 * never required: a player without it sees a plain oak door where a marker is, still a way
 * through, and every label's words are the same.
 */
import { exactly, type Facing, YAW } from './arcade/datapack.ts'
import { backToHub, badge, type Picture, wayOut } from './brand-art.ts'

/** The pack's names for its markers, as an item's `custom_model_data` carries them. */
export const MARKERS = {
  /** The item every Arcade player keeps, that takes them back to the hub. */
  backToHub: 'cubepals:back_to_hub',
  /** Over a way through, out of where a player is: an open door. */
  wayOut: 'cubepals:way_out',
} as const

type Marker = (typeof MARKERS)[keyof typeof MARKERS]

/** The item a marker is drawn on, and what it draws as without the pack. */
export const MARKER_ITEM = 'minecraft:oak_door'

/** A marker's item, as an item component in a command names it. */
export const markerData = (marker: Marker): string => `custom_model_data={strings:["${marker}"]}`

/** A marker shown in the world, over a way in or out. */
export interface ShownMarker {
  marker: Marker
  /** Its middle. */
  at: readonly [number, number, number]
  /** Flat on a wall, facing out from it; without, it turns to whoever looks. */
  facing?: Facing
  /** Its side, in blocks. */
  scale?: number
}

/** The command that shows a marker, as an item display lit as by day, with the tags it is found by. */
export function showMarker(shown: ShownMarker, tags: readonly string[]): string {
  const scale = shown.scale ?? 1
  const turn =
    shown.facing === undefined
      ? 'billboard:"vertical"'
      : `billboard:"fixed",Rotation:[${YAW[shown.facing]}f,0f]`
  return `summon minecraft:item_display ${exactly(shown.at)} {Tags:[${tags.map((tag) => `"${tag}"`).join(',')}],item:{id:"${MARKER_ITEM}",count:1,components:{"minecraft:custom_model_data":{strings:["${shown.marker}"]}}},item_display:"none",${turn},brightness:{block:15,sky:15},transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[${scale}f,${scale}f,${scale}f]}}`
}

/**
 * The resource formats the pack is for: from 1.21.4's, 46, the first with the item definitions it
 * uses (Mojang's client jar, `version.json`, `pack_version.resource_major`), and every one after.
 * Through Via, the Arcade takes players from releases older than its own, and a 1.21.4 to 1.21.8
 * game ignores a pack that has no `pack_format`, every marker then drawn as vanilla's oak door: so
 * the pack names its range both ways, as `min_format` and `max_format`, which releases from 1.21.9
 * read, and as `pack_format` and `supported_formats`, which those before do.
 */
export const RESOURCE_FORMATS = { min: 46, max: 1000 } as const

export type PackFile = { path: string; json: unknown } | { path: string; picture: Picture }

const PICTURES: Record<Marker, Picture> = {
  [MARKERS.backToHub]: backToHub(),
  [MARKERS.wayOut]: wayOut(),
}

/** A marker's own name, without its namespace: `way_out`. */
const nameOf = (marker: Marker) => marker.slice('cubepals:'.length)

/**
 * The oak door's item, as vanilla defines it, unless it carries a marker's name: then the marker's
 * model. A marker drawn as an item is flat, as vanilla's oak door is, a sixteenth thick.
 */
const OAK_DOOR = {
  model: {
    type: 'minecraft:select',
    property: 'minecraft:custom_model_data',
    index: 0,
    cases: Object.values(MARKERS).map((marker) => ({
      when: marker,
      model: { type: 'minecraft:model', model: `cubepals:item/${nameOf(marker)}` },
    })),
    fallback: { type: 'minecraft:model', model: 'minecraft:item/oak_door' },
  },
}

export const BRAND_PACK: readonly PackFile[] = [
  {
    path: 'pack.mcmeta',
    json: {
      pack: {
        description: 'Cubepals: doors and markers on our own servers',
        min_format: RESOURCE_FORMATS.min,
        max_format: RESOURCE_FORMATS.max,
        pack_format: RESOURCE_FORMATS.min,
        supported_formats: [RESOURCE_FORMATS.min, RESOURCE_FORMATS.max],
      },
    },
  },
  { path: 'pack.png', picture: badge(64) },
  { path: 'assets/minecraft/items/oak_door.json', json: OAK_DOOR },
  ...Object.values(MARKERS).flatMap((marker): PackFile[] => [
    {
      path: `assets/cubepals/models/item/${nameOf(marker)}.json`,
      json: { parent: 'minecraft:item/generated', textures: { layer0: `cubepals:item/${nameOf(marker)}` } },
    },
    { path: `assets/cubepals/textures/item/${nameOf(marker)}.png`, picture: PICTURES[marker] },
  ]),
]

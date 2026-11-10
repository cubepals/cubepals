// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the game draws an item in an inventory slot, read from its own model files: flat layers for
 * most items, a cube's three visible faces for most blocks. From 1.21.4 an item's definition in
 * `items/<id>.json` names its model and its tints; before, the model is `models/item/<id>.json`
 * and the few tints are the game's code, so the common ones are here. The files are the release's
 * own, read from its client jar (`app/items/`); nothing of Mojang's is in Blockly.
 *
 * Deliberately simple: a model whose shape isn't a whole cube (stairs, fences, torches as blocks)
 * is drawn flat from one of its textures. One the game draws in code (shields, chests, heads) is
 * cut from its entity texture instead (`entity-items.ts`).
 */

import { type BedTop, type CutIcon, entityIconOf, lyingBed } from './entity-items.ts'

/** A texture under `textures/`, without `.png`: `block/oak_log`, `item/diamond_sword`. */
interface Paint {
  texture: string
  /** RGB multiplied into the texture, for the layers and faces the game tints. */
  tint: number | null
}

export type ItemIcon =
  | { kind: 'flat'; layers: Paint[] }
  | { kind: 'block'; top: Paint; left: Paint; right: Paint }
  | CutIcon
  | null

/** What the resolver may read: a JSON file under `assets/minecraft/`, and whether a texture is there. */
export interface ModelFiles {
  json(path: string): unknown
  hasTexture(texture: string): boolean
}

type Data = Record<string, unknown>
const isData = (value: unknown): value is Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The icon for a vanilla item id; null for another namespace's, or one with nothing to draw. */
export function iconOf(id: string, files: ModelFiles): ItemIcon {
  const match = /^minecraft:([a-z0-9_]+)$/.exec(id)
  if (match === null) return null
  const path = match[1] ?? ''
  const drawn = entityIconOf(path, files.hasTexture)
  if (drawn) return drawn
  const definition = files.json(`items/${path}.json`)
  // Drawn from entity textures before 26.2, a bed is block models after: those, where they are.
  const composed = composedBed(definition, files)
  if (composed !== undefined || drawn === null) return composed ?? null
  const chosen = chooseModel(definition)
  if (chosen === 'special') return null
  const model = chosen?.model ?? `item/${path}`
  const tints = chosen === null ? oldTints(path) : chosen.tints
  const resolved = resolveModel(model, files)
  if (resolved === null) return null
  const paint: Painter = (ref, tintIndex) => {
    const texture = textureOf(ref, resolved.textures)
    if (texture === null || !files.hasTexture(texture)) return null
    return { texture, tint: typeof tintIndex === 'number' ? (tints[tintIndex] ?? null) : null }
  }
  if (resolved.flat) {
    const layers = [0, 1, 2, 3, 4].flatMap((i) => paint(resolved.textures[`layer${i}`], i) ?? [])
    return layers.length > 0 ? { kind: 'flat', layers } : null
  }
  return cubeOf(wholeCube(resolved.elements), paint) ?? oneFace(resolved.textures, paint)
}

/**
 * Every item a release has, by its path (`diamond_sword`). From 1.21.4 each has its definition in
 * `items/`. Before, each has a model in `models/item/`, beside models only drawn in its place (a
 * bow being drawn, a clock's faces) and templates other items are made from, which are left out.
 */
export function itemsOf(paths: readonly string[], files: Pick<ModelFiles, 'json'>): string[] {
  const defined = namedIn(paths, 'items/').filter((path) => path !== 'air')
  if (defined.length > 0) return defined
  const models = new Map(
    namedIn(paths, 'models/item/').map((path) => [path, files.json(`models/item/${path}.json`)]),
  )
  // A clock's overrides name the clock itself among its faces: it is still an item.
  const swapped = new Set(
    [...models].flatMap(([path, model]) => refsOf(overridesOf(model)).filter((ref) => ref !== path)),
  )
  // A bow being drawn is made from the bow, which stays; a spawn egg from a template, which goes.
  const templates = new Set(
    [...models].flatMap(([path, model]) =>
      swapped.has(path) || !isData(model) ? [] : refsOf([model.parent]),
    ),
  )
  // What the game's code draws in a hand in its place (a trident, a spyglass) is no item of its own.
  return [...models.keys()].filter(
    (path) => !swapped.has(path) && !templates.has(path) && !path.endsWith('_in_hand') && path !== 'air',
  )
}

function namedIn(paths: readonly string[], dir: string): string[] {
  return paths
    .flatMap((path) => {
      const name =
        path.startsWith(dir) && path.endsWith('.json') ? path.slice(dir.length, -'.json'.length) : ''
      return /^[a-z0-9_]+$/.test(name) ? [name] : []
    })
    .sort()
}

/** The models an item's overrides draw in its place. */
function overridesOf(model: unknown): unknown[] {
  if (!isData(model) || !Array.isArray(model.overrides)) return []
  return model.overrides.map((o: unknown) => (isData(o) ? o.model : null))
}

/** The item models among `refs`, by path: `item/bow_pulling_0` is `bow_pulling_0`. */
function refsOf(refs: readonly unknown[]): string[] {
  return refs.flatMap((ref) => {
    const match = typeof ref === 'string' ? /^(?:minecraft:)?item\/([a-z0-9_]+)$/.exec(ref) : null
    return match?.[1] ? [match[1]] : []
  })
}

/**
 * From 26.2 a bed's definition puts its two block models side by side (`minecraft:composite`):
 * drawn from the top face of each, lying across as before. Undefined for any other definition.
 */
function composedBed(definition: unknown, files: ModelFiles): ItemIcon | undefined {
  const node = isData(definition) ? definition.model : undefined
  if (!isData(node) || node.type !== 'minecraft:composite' || !Array.isArray(node.models)) return undefined
  const names = node.models.flatMap((m: unknown) =>
    isData(m) && typeof m.model === 'string' ? [m.model.replace(/^minecraft:/, '')] : [],
  )
  const head = names.find((name) => name.endsWith('_bed_head'))
  const foot = names.find((name) => name.endsWith('_bed_foot'))
  if (head === undefined || foot === undefined) return undefined
  const [top, bottom] = [topOf(head, files), topOf(foot, files)]
  return top === null || bottom === null ? null : lyingBed(top, bottom)
}

/** A block model's first top face: its texture, and the part of it the face shows. */
function topOf(model: string, files: ModelFiles): BedTop | null {
  const resolved = resolveModel(model, files)
  const up = resolved?.elements?.flatMap((e) =>
    isData(e) && isData(e.faces) && isData(e.faces.up) ? [e.faces.up] : [],
  )[0]
  const texture = textureOf(
    typeof up?.texture === 'string' ? up.texture : undefined,
    resolved?.textures ?? {},
  )
  if (texture === null || !files.hasTexture(texture)) return null
  const uv = Array.isArray(up?.uv) && up.uv.length === 4 ? (up.uv as number[]) : [0, 0, 16, 16]
  const [x1 = 0, y1 = 0, x2 = 16, y2 = 16] = uv
  // A model's UV is in sixteenths of its texture, whatever its size; a reversed one is mirrored.
  return {
    texture,
    size: [16, 16],
    from: [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)],
  }
}

type Painter = (ref: string | undefined, tintIndex: unknown) => Paint | null

function cubeOf(faces: Record<string, Face> | null, paint: Painter): ItemIcon {
  if (faces === null) return null
  const top = paint(faces.up?.texture, faces.up?.tintindex)
  const left = paint(faces.north?.texture, faces.north?.tintindex)
  const right = paint(faces.east?.texture, faces.east?.tintindex)
  return top !== null && left !== null && right !== null ? { kind: 'block', top, left, right } : null
}

/** Too complex to draw as a cube: one of its faces, rather than nothing. */
function oneFace(textures: Record<string, string>, paint: Painter): ItemIcon {
  for (const ref of ['particle', 'side', 'all', 'texture', 'north', 'top']) {
    const one = paint(textures[ref], undefined)
    if (one !== null) return { kind: 'flat', layers: [one] }
  }
  return null
}

/**
 * The model an item definition draws in an inventory, and its tints: through selections and
 * conditions to the case for an inventory, else their fallback (or first case); `special` for one the game's code draws, and
 * null where there is no definition, as before 1.21.4.
 */
function chooseModel(definition: unknown): { model: string; tints: (number | null)[] } | null | 'special' {
  let node = isData(definition) ? definition.model : undefined
  for (let depth = 0; depth < 16 && isData(node); depth++) {
    if (typeof node.model === 'string') return { model: node.model, tints: tintsOf(node.tints) }
    // Drawn by the game's code (a shield, a chest, a head): nothing a texture alone shows.
    if (node.type === 'minecraft:special') return 'special'
    node = nextOf(node)
  }
  return null
}

/**
 * Where a selection or condition leads in an inventory: the case for one (`gui`), as a trident is
 * flat there and drawn in a hand; else its fallback, or its first case.
 */
function nextOf(node: Data): unknown {
  const cases = Array.isArray(node.cases) ? node.cases : Array.isArray(node.entries) ? node.entries : []
  const inGui = cases.find((c: unknown) => isData(c) && Array.isArray(c.when) && c.when.includes('gui'))
  if (isData(inGui)) return inGui.model
  return node.fallback ?? node.on_false ?? (isData(cases[0]) ? cases[0].model : undefined)
}

function tintsOf(tints: unknown): (number | null)[] {
  if (!Array.isArray(tints)) return []
  return tints.map((tint) => {
    if (!isData(tint)) return null
    const value = tint.value ?? tint.default
    if (typeof value === 'number') return value & 0xffffff
    return tint.type === 'minecraft:grass' ? GRASS : null
  })
}

/** What 1.21.4 and later write in item definitions, for the releases that kept it in code. */
function oldTints(path: string): (number | null)[] {
  if (/^(potion|splash_potion|lingering_potion|tipped_arrow)$/.test(path)) return [WATER]
  if (/^leather_(helmet|chestplate|leggings|boots|horse_armor)$/.test(path)) return [LEATHER]
  if (path === 'spruce_leaves') return [0x619961]
  if (path === 'birch_leaves') return [0x80a755]
  if (/^(oak|jungle|acacia|dark_oak|mangrove)_leaves$|^vine$/.test(path)) return [FOLIAGE]
  if (/^(grass_block|grass|short_grass|tall_grass|fern|large_fern)$/.test(path)) return [GRASS]
  return []
}
const WATER = 0x385dc6
const LEATHER = 0xa06540
const FOLIAGE = 0x48b518
const GRASS = 0x91bd59

/** A model followed through its parents: its textures, its first elements, and whether it is flat. */
function resolveModel(
  model: string,
  files: ModelFiles,
): { textures: Record<string, string>; elements: unknown[] | null; flat: boolean } | null {
  const { chain, end } = chainOf(model, files)
  if (chain.length === 0 || end === 'builtin/entity') return null
  // A child's names win over its parents', and its shape too.
  const textures = Object.assign({}, ...chain.map((json) => namesOf(json.textures)).reverse())
  const elements = chain.find((json) => Array.isArray(json.elements))?.elements as unknown[] | undefined
  return {
    textures,
    elements: elements ?? null,
    flat: end === 'builtin/generated' || end === 'item/generated',
  }
}

/** The model and its parents, child first, and the name the chain ended at. */
function chainOf(model: string, files: ModelFiles): { chain: Data[]; end: string | null } {
  const chain: Data[] = []
  let name: string | null = model.replace(/^minecraft:/, '')
  while (name !== null && chain.length < 16 && !ENDS.has(name)) {
    const json = files.json(`models/${name}.json`)
    // A parent missing ends the chain where it is.
    if (!isData(json)) break
    chain.push(json)
    name = typeof json.parent === 'string' ? json.parent.replace(/^minecraft:/, '') : null
  }
  return { chain, end: name }
}
const ENDS = new Set(['builtin/generated', 'item/generated', 'builtin/entity'])

/** A model's texture names; 1.21.6 and later may write one as `{ sprite, force_translucent }`. */
function namesOf(textures: unknown): Record<string, string> {
  if (!isData(textures)) return {}
  return Object.fromEntries(
    Object.entries(textures).flatMap(([key, value]) => {
      const name = isData(value) ? value.sprite : value
      return typeof name === 'string' ? [[key, name]] : []
    }),
  )
}

/** `#side` through the model's own names to `block/oak_log`; null outside `block/` and `item/`. */
function textureOf(ref: string | undefined, textures: Record<string, string>): string | null {
  let value = ref
  for (let depth = 0; depth < 8 && value?.startsWith('#'); depth++) value = textures[value.slice(1)]
  const path = value?.replace(/^minecraft:/, '')
  return path !== undefined && /^(block|item)\/[a-z0-9_/]+$/.test(path) ? path : null
}

type Face = { texture?: string; tintindex?: unknown }

/** The faces of a model that is one whole cube, as a block's is; null for any other shape. */
function wholeCube(elements: unknown[] | null): Record<string, Face> | null {
  const first = elements?.[0]
  if (!isData(first) || !isData(first.faces)) return null
  const whole = JSON.stringify(first.from) === '[0,0,0]' && JSON.stringify(first.to) === '[16,16,16]'
  return whole ? (first.faces as Record<string, Face>) : null
}

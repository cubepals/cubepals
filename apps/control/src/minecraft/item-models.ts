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
 * is drawn flat from one of its textures, and one drawn by code (shields, chests, heads) has no
 * picture at all, and the page writes its name instead.
 */

/** A texture under `textures/`, without `.png`: `block/oak_log`, `item/diamond_sword`. */
interface Paint {
  texture: string
  /** RGB multiplied into the texture, for the layers and faces the game tints. */
  tint: number | null
}

export type ItemIcon =
  | { kind: 'flat'; layers: Paint[] }
  | { kind: 'block'; top: Paint; left: Paint; right: Paint }
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
  const chosen = chooseModel(files.json(`items/${path}.json`))
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
 * conditions to their fallback (or first case); `special` for one the game's code draws, and
 * null where there is no definition, as before 1.21.4.
 */
function chooseModel(definition: unknown): { model: string; tints: (number | null)[] } | null | 'special' {
  let node = isData(definition) ? definition.model : undefined
  for (let depth = 0; depth < 16 && isData(node); depth++) {
    if (typeof node.model === 'string') return { model: node.model, tints: tintsOf(node.tints) }
    // Drawn by the game's code (a shield, a chest, a head): nothing a texture alone shows.
    if (node.type === 'minecraft:special') return 'special'
    const cases = Array.isArray(node.cases) ? node.cases : Array.isArray(node.entries) ? node.entries : []
    node = node.fallback ?? node.on_false ?? (isData(cases[0]) ? cases[0].model : undefined)
  }
  return null
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

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A player's items as Minecraft keeps them, read into what the player page shows: where each
 * stack sits, what it is, how many, and what its tooltip would say (its name, a name someone gave
 * it, enchantments, a potion's effect, durability). Every release Blockly runs keeps items one of
 * two ways, and both come in here as plain data, from a file or from `data get` alike:
 *
 *  - 1.20.1: `Count` and a `tag` (`Damage`, `Enchantments`, `display.Name` as JSON text), with
 *    armor at slots 100–103 and the offhand at -106 in `Inventory`.
 *  - 1.20.5 on: `count` and `components` (`minecraft:damage`, `minecraft:enchantments`,
 *    `minecraft:custom_name`), and from 1.21.5 armor and the offhand in `equipment`.
 *
 * Not the pictures: icons are `app/items/`'s.
 */

interface ItemStack {
  /** Namespaced: `minecraft:diamond_sword`. */
  id: string
  count: number
  /** What the game calls it, or the name someone gave it. */
  name: string
  /** True when `name` is a name someone gave it. */
  named: boolean
  /** As the tooltip words them: "Sharpness III". */
  enchantments: string[]
  /** A potion's effect, as the game names it: "Swiftness". */
  potion: string | null
  durability: { left: number; max: number } | null
}

export interface Inventory {
  /** Nine slots, left to right. */
  hotbar: (ItemStack | null)[]
  /** Twenty-seven slots, row by row. */
  main: (ItemStack | null)[]
  armor: { head: ItemStack | null; chest: ItemStack | null; legs: ItemStack | null; feet: ItemStack | null }
  offhand: ItemStack | null
  /** Twenty-seven slots, row by row. */
  enderChest: (ItemStack | null)[]
}

type Data = Record<string, unknown>
const isData = (value: unknown): value is Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.filter(isData) : [])

const ARMOR_SLOTS = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head' } as const
const OFFHAND_SLOT = -106

/**
 * Everything a player carries: `Inventory` and `EnderItems`, and `equipment` where the release
 * keeps armor and the offhand there. Any of them may be missing, as an empty one is.
 */
export function inventoryOf(fields: {
  Inventory?: unknown
  EnderItems?: unknown
  equipment?: unknown
}): Inventory {
  const inventory: Inventory = {
    hotbar: Array(9).fill(null),
    main: Array(27).fill(null),
    armor: { head: null, chest: null, legs: null, feet: null },
    offhand: null,
    enderChest: Array(27).fill(null),
  }
  for (const raw of list(fields.Inventory)) place(inventory, Number(raw.Slot), stackOf(raw))
  if (isData(fields.equipment)) {
    const equipment = fields.equipment
    for (const part of ['head', 'chest', 'legs', 'feet'] as const)
      inventory.armor[part] = stackOf(equipment[part]) ?? inventory.armor[part]
    inventory.offhand = stackOf(equipment.offhand) ?? inventory.offhand
  }
  for (const raw of list(fields.EnderItems)) {
    const slot = Number(raw.Slot)
    if (slot >= 0 && slot < 27) inventory.enderChest[slot] = stackOf(raw)
  }
  return inventory
}

/** Where `Inventory`'s slot numbers put a stack: hotbar, the rest, and in 1.20.1 armor and offhand. */
function place(inventory: Inventory, slot: number, stack: ItemStack | null): void {
  if (stack === null) return
  if (slot >= 0 && slot < 9) inventory.hotbar[slot] = stack
  else if (slot >= 9 && slot < 36) inventory.main[slot - 9] = stack
  else if (slot in ARMOR_SLOTS) inventory.armor[ARMOR_SLOTS[slot as keyof typeof ARMOR_SLOTS]] = stack
  else if (slot === OFFHAND_SLOT) inventory.offhand = stack
}

/** One stack, in either way a release keeps it; null for an empty slot or what isn't one. */
function stackOf(raw: unknown): ItemStack | null {
  if (!isData(raw) || typeof raw.id !== 'string' || raw.id === 'minecraft:air') return null
  const id = raw.id.includes(':') ? raw.id : `minecraft:${raw.id}`
  const count = Number(raw.count ?? raw.Count ?? 1)
  const tag = isData(raw.tag) ? raw.tag : {}
  const components = isData(raw.components) ? raw.components : {}
  const display = isData(tag.display) ? tag.display : {}
  const given = plainText(components['minecraft:custom_name'] ?? parseJson(display.Name))
  const damage = Number(components['minecraft:damage'] ?? tag.Damage ?? 0)
  const max = Number(components['minecraft:max_damage'] ?? maxDamage(id) ?? 0)
  return {
    id,
    count: Number.isFinite(count) && count > 0 ? count : 1,
    name: given ?? wordsOf(id),
    named: given !== null,
    enchantments: enchantmentsOf(tag, components),
    potion: potionOf(tag, components),
    durability: max > 0 && damage > 0 ? { left: Math.max(0, max - damage), max } : null,
  }
}

function enchantmentsOf(tag: Data, components: Data): string[] {
  return [
    ...levelsOf(components['minecraft:enchantments']),
    ...levelsOf(components['minecraft:stored_enchantments']),
    ...list(tag.Enchantments).map((e) => [String(e.id), Number(e.lvl)] as const),
    ...list(tag.StoredEnchantments).map((e) => [String(e.id), Number(e.lvl)] as const),
  ].map(([id, level]) => enchantmentName(id, level))
}

/** The effect a potion, a splash or a tipped arrow carries; none for water and the plain brews. */
function potionOf(tag: Data, components: Data): string | null {
  const contents = components['minecraft:potion_contents']
  const potion = isData(contents) ? contents.potion : typeof contents === 'string' ? contents : tag.Potion
  if (typeof potion !== 'string' || /:(water|empty|mundane|thick|awkward)$/.test(potion)) return null
  return effectOf(potion)
}

/** `{"minecraft:sharpness": 3}`, or, from 1.20.5 to 1.21.4, the same under `levels`. */
function levelsOf(value: unknown): Array<readonly [string, number]> {
  if (!isData(value)) return []
  const levels = isData(value.levels) ? value.levels : value
  return Object.entries(levels)
    .filter(([key]) => key !== 'show_in_tooltip')
    .map(([key, level]) => [key, Number(level)] as const)
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** A text component's words, without its colours: a string, `{text, extra}`, or a list of them. */
function plainText(component: unknown): string | null {
  const words = (part: unknown): string => {
    if (typeof part === 'string') return part
    if (Array.isArray(part)) return part.map(words).join('')
    if (!isData(part)) return ''
    const text =
      typeof part.text === 'string' ? part.text : typeof part.translate === 'string' ? part.translate : ''
    return text + (Array.isArray(part.extra) ? part.extra.map(words).join('') : '')
  }
  const text = words(component).trim()
  return text === '' ? null : text
}

/** `minecraft:diamond_sword` → "Diamond Sword", as the game's English names nearly all read. */
function wordsOf(id: string): string {
  const path = id.slice(id.indexOf(':') + 1)
  return path
    .split('_')
    .map((word) => (OF.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}
const OF = new Set(['of', 'on', 'a', 'the', 'and'])

/** Enchantments that only come at one level, whose tooltip has no numeral. */
const ONE_LEVEL = new Set([
  'mending',
  'infinity',
  'silk_touch',
  'flame',
  'channeling',
  'multishot',
  'aqua_affinity',
  'binding_curse',
  'vanishing_curse',
])
const NUMERALS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']

function enchantmentName(id: string, level: number): string {
  const path = id.slice(id.indexOf(':') + 1)
  const name =
    path === 'binding_curse'
      ? 'Curse of Binding'
      : path === 'vanishing_curse'
        ? 'Curse of Vanishing'
        : wordsOf(id)
  if (ONE_LEVEL.has(path) && level === 1) return name
  return `${name} ${NUMERALS[level] ?? level}`
}

/** `minecraft:long_swiftness` → "Swiftness". */
function effectOf(potion: string): string {
  return wordsOf(potion.replace(/:(long|strong)_/, ':'))
}

/**
 * How much use a vanilla item takes before it breaks. Nothing in a player's data says, unless a
 * component changed it, so the game's own numbers are here.
 */
function maxDamage(id: string): number | null {
  const path = id.replace(/^minecraft:/, '')
  const named = SINGLE_DURABILITY[path]
  if (named !== undefined) return named
  const tool = /^(wooden|stone|iron|golden|diamond|netherite)_(sword|pickaxe|axe|shovel|hoe)$/.exec(path)
  if (tool) return TOOL_TIERS[tool[1] as keyof typeof TOOL_TIERS]
  const armor = /^(leather|chainmail|iron|golden|diamond|netherite)_(helmet|chestplate|leggings|boots)$/.exec(
    path,
  )
  if (armor)
    return (
      ARMOR_TIERS[armor[1] as keyof typeof ARMOR_TIERS] * ARMOR_PIECES[armor[2] as keyof typeof ARMOR_PIECES]
    )
  return null
}
const TOOL_TIERS = { wooden: 59, stone: 131, iron: 250, golden: 32, diamond: 1561, netherite: 2031 }
const ARMOR_TIERS = { leather: 5, chainmail: 15, iron: 15, golden: 7, diamond: 33, netherite: 37 }
const ARMOR_PIECES = { helmet: 11, chestplate: 16, leggings: 15, boots: 13 }
const SINGLE_DURABILITY: Record<string, number> = {
  bow: 384,
  crossbow: 465,
  trident: 250,
  shield: 336,
  elytra: 432,
  fishing_rod: 64,
  shears: 238,
  flint_and_steel: 64,
  carrot_on_a_stick: 25,
  warped_fungus_on_a_stick: 100,
  turtle_helmet: 275,
  mace: 500,
  brush: 64,
}

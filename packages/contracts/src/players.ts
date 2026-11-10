// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One player on one server: where they are, where they died, their game mode, what they carry,
 * a few stats, and what waits for them to join. Their access is `access.ts`'s, read and changed
 * there.
 */
import { z } from 'zod'
import { PlayerInput } from './access.ts'
import { GAME_MODES } from './server.ts'

export type GameMode = (typeof GAME_MODES)[number]

export const TeleportInput = PlayerInput.extend({ to: z.enum(['death', 'spawn']) })
export const GameModeInput = PlayerInput.extend({ mode: z.enum(GAME_MODES) })
/**
 * What can wait for a player: a trip somewhere, a game mode, items, levels, an emptied inventory,
 * or a kept one put back. One of each at most; items and levels asked again add up.
 */
export const WAITING_KINDS = ['place', 'game_mode', 'give', 'levels', 'clear_inventory', 'put_back'] as const
export const WaitingInput = PlayerInput.extend({ kind: z.enum(WAITING_KINDS) })
/** The worlds every release has, by the game's own names for them. */
export const DIMENSIONS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'] as const
/** How far out the game lets anyone stand: its world border's widest (minecraft.wiki, World border). */
const WORLD_EDGE = 29_999_984
/** Heights a trip can name: well past any world's floor and ceiling, which datapacks can move. */
const HEIGHT = 4064
/**
 * An item as `give` names it: `diamond` or `minecraft:diamond`, a mod's `create:wrench`. Nothing
 * else, so no components or tags reach the command.
 */
const ITEM_ID = /^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/
/** The most one give hands over: the game refuses more than a hundred stacks of anything. */
export const MOST_GIVEN = 6400
/** The most levels one ask gives, and the most that wait for one player. */
export const MOST_LEVELS = 1000

/**
 * What the owner can do to a player from their page: a trip to a place (on the ground there when
 * no height is given) or to another player, an item, their health and hunger back, levels, a
 * kick, or an empty inventory. A trip to a place, items, levels and an emptied inventory wait for
 * someone away; the rest only mean something while they are on.
 */
export const PlayerPower = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('teleport'),
    dimension: z.enum(DIMENSIONS),
    x: z.number().int().min(-WORLD_EDGE).max(WORLD_EDGE),
    y: z.number().int().min(-HEIGHT).max(HEIGHT).nullable(),
    z: z.number().int().min(-WORLD_EDGE).max(WORLD_EDGE),
  }),
  z.object({ kind: z.literal('to_player'), to: z.guid() }),
  z.object({
    kind: z.literal('give'),
    item: z.string().max(100).regex(ITEM_ID),
    count: z.number().int().min(1).max(MOST_GIVEN),
  }),
  z.object({ kind: z.literal('heal') }),
  z.object({ kind: z.literal('levels'), levels: z.number().int().min(1).max(MOST_LEVELS) }),
  z.object({ kind: z.literal('kick'), reason: z.string().max(200) }),
  z.object({ kind: z.literal('clear_inventory') }),
])
export type PlayerPower = z.infer<typeof PlayerPower>
export const PlayerPowerInput = PlayerInput.extend({ power: PlayerPower })
/** A kept inventory's id, as `KeptInventoryView` gives it. */
export const KEPT_ID = /^k[0-9a-f]{12}$/
export const PutBackInput = PlayerInput.extend({ kept: z.string().regex(KEPT_ID) })

/** Every item a release has: `ItemIcons.items`. */
export const ItemListInput = z.object({ gameVersion: z.string().max(40) })

export const ItemIconsInput = z.object({
  gameVersion: z.string().max(40),
  ids: z.array(z.string().max(100)).max(80),
})

/** A block in a dimension, as the game names it: `minecraft:the_nether`. */
export interface PlaceView {
  dimension: string
  x: number
  y: number
  z: number
}

export interface ItemStackView {
  id: string
  count: number
  name: string
  /** True when someone gave it its name. */
  named: boolean
  enchantments: string[]
  potion: string | null
  durability: { left: number; max: number } | null
}

export type SlotView = ItemStackView | null

export interface InventoryView {
  hotbar: SlotView[]
  main: SlotView[]
  armor: { head: SlotView; chest: SlotView; legs: SlotView; feet: SlotView }
  offhand: SlotView
  enderChest: SlotView[]
}

/**
 * Something asked for while the player was away, done when they next join: back where they died,
 * to the spawn or to coordinates (`there`); a game mode; the items and levels waiting, all of
 * them; or an emptied inventory, which is done before any items, so they keep those.
 */
export type WaitingView = { askedAt: string } & (
  | { kind: 'place'; what: 'death' | 'spawn' }
  | { kind: 'place'; what: 'there'; there: { dimension: string; x: number; y: number | null; z: number } }
  | { kind: 'game_mode'; what: GameMode }
  | { kind: 'give'; items: { item: string; count: number }[] }
  | { kind: 'levels'; levels: number }
  | { kind: 'clear_inventory' }
  | { kind: 'put_back'; kept: string }
)

/**
 * What a player carried when their inventory was emptied, kept so it can be put back: the newest
 * few, newest first. The items are as the page shows them; the world keeps them whole.
 */
export interface KeptInventoryView {
  id: string
  keptAt: string
  items: ItemStackView[]
}

export interface PlayerView {
  uuid: string
  name: string
  online: boolean
  lastSeenAt: string | null
  /**
   * Where the rest came from: the game itself while they are on (`live`), their files while the
   * server runs (`files`), what was kept when it went to sleep (`snapshot`), or nothing yet.
   */
  source: 'live' | 'files' | 'snapshot' | 'none'
  /** When the snapshot was kept, for `snapshot`. */
  asOf: string | null
  position: PlaceView | null
  lastDeath: PlaceView | null
  gameMode: GameMode | null
  inventory: InventoryView | null
  stats: { playMinutes: number | null; deaths: number | null } | null
  waiting: WaitingView[]
  kept: KeptInventoryView[]
}

/** Whether a change happened now, or waits for the player to join. */
export interface PlayerChangeView {
  done: 'now' | 'when_they_join'
  /** What Blockly did instead of what was asked, in a sentence for the page. */
  note?: string
}

/**
 * How the browser draws one item: flat layers, or a block's three visible faces, each whole
 * textures or cut from an entity's (`ItemCutView`). Each texture is
 * named as the release names it (`block/oak_log`), and served at
 * `/api/public/items/<release>/<texture>.png`; `tint` is an RGB colour for what the game tints.
 * Null where there is nothing to draw, and the page shows the item's name.
 */
export type ItemIconView =
  | { kind: 'flat'; layers: { texture: string; tint: number | null }[] }
  | {
      kind: 'block'
      top: { texture: string; tint: number | null }
      left: { texture: string; tint: number | null }
      right: { texture: string; tint: number | null }
    }
  | { kind: 'cut'; cuts: ItemCutView[] }
  | { kind: 'cut_block'; top: ItemCutView[]; left: ItemCutView[]; right: ItemCutView[] }
  | null

/**
 * A rectangle of a texture drawn onto part of a picture, for what the game draws from an entity's
 * texture (a chest, a bed, a head): `from` in the texture's pixels, of a texture `size` across;
 * `to` in sixteenths of the face.
 */
export interface ItemCutView {
  texture: string
  size: [number, number]
  from: [number, number, number, number]
  to: [number, number, number, number]
  tint: number | null
  /** Turned clockwise in its place, in degrees. */
  turn: 0 | 90 | 180 | 270
}

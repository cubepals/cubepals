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
/** What waits for a player: a trip somewhere, or a game mode. One of each at most. */
export const WaitingInput = PlayerInput.extend({ kind: z.enum(['place', 'game_mode']) })
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

/** Something asked for while the player was away, done when they next join. */
export interface WaitingView {
  kind: 'place' | 'game_mode'
  /** `death` and `spawn` for a place; a mode's name for a game mode. */
  what: 'death' | 'spawn' | GameMode
  askedAt: string
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
}

/** Whether a change happened now, or waits for the player to join. */
export interface PlayerChangeView {
  done: 'now' | 'when_they_join'
}

/**
 * How the browser draws one item: flat layers, or a block's three visible faces. Each texture is
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
  | null

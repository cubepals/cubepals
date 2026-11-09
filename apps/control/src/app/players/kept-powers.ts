// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The owner's buttons that wait for a player who is away, as rows of `player_actions_waiting`:
 * which of them can wait, how a second ask meets one already waiting, the powers that do it when
 * they next join, and how their page shows it. A trip back or to the spawn and a game mode are
 * `reading.ts`'s to do; who may ask, and the audit, are the service's.
 */
import { MOST_GIVEN, MOST_LEVELS, type PlayerPower, type WaitingView } from '@blockly/contracts'
import { z } from 'zod'
import type { WaitingKind } from './persistence.ts'

/** The most different items that wait for one player: an inventory's worth. */
const MOST_ITEMS = 36

/** Done in this order as they join: an emptied inventory first, so the items given after stay. */
const IN_ORDER: readonly WaitingKind[] = ['clear_inventory', 'place', 'game_mode', 'give', 'levels']

const There = z.object({
  dimension: z.string(),
  x: z.number().int(),
  y: z.number().int().nullable(),
  z: z.number().int(),
})
const Items = z.array(z.object({ item: z.string(), count: z.number().int().min(1) }))

/**
 * What waits for `power` while they are away; null for a heal, a kick or a trip to someone on
 * now, which mean nothing once the moment has passed.
 */
export function keptOf(power: PlayerPower): { kind: WaitingKind; what: string } | null {
  switch (power.kind) {
    case 'teleport': {
      const { dimension, x, y, z } = power
      return { kind: 'place', what: JSON.stringify({ dimension, x, y, z }) }
    }
    case 'give':
      return { kind: 'give', what: JSON.stringify([{ item: itemId(power.item), count: power.count }]) }
    case 'levels':
      return { kind: 'levels', what: String(power.levels) }
    case 'clear_inventory':
      return { kind: 'clear_inventory', what: 'all' }
    default:
      return null
  }
}

/**
 * A second ask with one already waiting: a trip replaces the trip, items and levels add up, and
 * one emptying is enough. Null where together they are more than the game hands over.
 */
export function joined(kind: WaitingKind, waiting: string | null, asked: string): string | null {
  if (waiting === null) return asked
  if (kind === 'levels') {
    const levels = Number(waiting) + Number(asked)
    return Number.isInteger(levels) && levels <= MOST_LEVELS ? String(levels) : null
  }
  if (kind !== 'give') return asked
  const items = new Map<string, number>()
  for (const { item, count } of [...itemsOf(waiting), ...itemsOf(asked)])
    items.set(item, (items.get(item) ?? 0) + count)
  if (items.size > MOST_ITEMS || [...items.values()].some((count) => count > MOST_GIVEN)) return null
  return JSON.stringify([...items].map(([item, count]) => ({ item, count })))
}

/**
 * The powers that do it as they join, in order; null for a trip back or to the spawn and a game
 * mode, which `reading.ts` does. Empty where the row can't be read, so it is dropped.
 */
export function keptPowers(kind: WaitingKind, what: string): PlayerPower[] | null {
  switch (kind) {
    case 'place': {
      if (what === 'death' || what === 'spawn') return null
      const there = thereOf(what)
      return there === null ? [] : [{ kind: 'teleport', ...there } as PlayerPower]
    }
    case 'game_mode':
      return null
    case 'give':
      return itemsOf(what).map(({ item, count }) => ({ kind: 'give', item, count }))
    case 'levels': {
      const levels = Number(what)
      return Number.isInteger(levels) && levels > 0 ? [{ kind: 'levels', levels }] : []
    }
    case 'clear_inventory':
      return [{ kind: 'clear_inventory' }]
  }
}

/** What is left of waiting items once the first of them were given. */
export function itemsLeft(powers: readonly PlayerPower[]): string {
  return JSON.stringify(
    powers.flatMap((power) => (power.kind === 'give' ? [{ item: power.item, count: power.count }] : [])),
  )
}

/** In the order they are done as the player joins. */
export function inJoinOrder<T extends { kind: WaitingKind }>(waiting: readonly T[]): T[] {
  return [...waiting].sort((a, b) => IN_ORDER.indexOf(a.kind) - IN_ORDER.indexOf(b.kind))
}

/** As the player's page shows it; null where the row can't be read, which their next join drops. */
export function waitingView(kind: WaitingKind, what: string, askedAt: Date): WaitingView | null {
  const at = askedAt.toISOString()
  switch (kind) {
    case 'place': {
      if (what === 'death' || what === 'spawn') return { kind, what, askedAt: at }
      const there = thereOf(what)
      return there === null ? null : { kind, what: 'there', there, askedAt: at }
    }
    case 'game_mode':
      return { kind, what: what as Extract<WaitingView, { kind: 'game_mode' }>['what'], askedAt: at }
    case 'give':
      return { kind, items: itemsOf(what), askedAt: at }
    case 'levels':
      return { kind, levels: Number(what), askedAt: at }
    case 'clear_inventory':
      return { kind, askedAt: at }
  }
}

/** `diamond` is `minecraft:diamond`, as the game reads it, so the two add up. */
function itemId(item: string): string {
  return item.includes(':') ? item : `minecraft:${item}`
}

function thereOf(what: string): z.infer<typeof There> | null {
  try {
    return There.parse(JSON.parse(what))
  } catch {
    return null
  }
}

function itemsOf(what: string): z.infer<typeof Items> {
  try {
    return Items.parse(JSON.parse(what))
  } catch {
    return []
  }
}

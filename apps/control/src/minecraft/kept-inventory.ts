// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeping what a player carries before their inventory is emptied, and putting it back, through
 * the console: the game copies it into the world's own storage (`blockly:kept`) item for item as
 * it holds them, names, enchantments and a shulker box's contents included, and the world keeps
 * that through restarts and sleep. Putting it back drops each item at the player's feet, for them
 * alone to pick up.
 *
 * An item entity can't be summoned empty and filled after: the game drops it as it is made, and
 * still says the fill worked. So each item is a placeholder no one can pick up, then filled from a
 * template (`next`) of the item, its owner and no pickup delay. Seen on a 26.1 server with a player
 * on: every item came back whole. Which clears are kept, and who may ask, is `app/players/`'s.
 */
import { type Step, vanilla } from './player-powers.ts'
import { safeName } from './players.ts'

/** The world storage that keeps each emptied inventory, under its id. */
const KEPT = 'blockly:kept'
/**
 * Marks one kept inventory's placeholder while it is filled, so two players' never meet; one left
 * behind is removed before the next, and despawns in five minutes as any dropped item does.
 */
const tag = (id: string) => `blockly.kept.${id}`
/** The `equipment` slots a release may keep there: armor, the offhand, and a ridden mob's. */
export const EQUIPMENT_SLOTS = ['head', 'chest', 'legs', 'feet', 'offhand', 'body', 'saddle'] as const
/** Far more than any inventory holds: where putting back stops, whatever the storage says. */
export const MOST_KEPT_ITEMS = 64

/**
 * Copies what `name` carries under `id`, before it is emptied: the inventory, then the equipment,
 * which a release before 1.21.5 doesn't have (its armor is in the inventory).
 */
export function keepSteps(name: string, id: string): [inventory: Step, equipment: Step] {
  const who = safeName(name)
  return [
    vanilla(`data modify storage ${KEPT} ${id}.Inventory set from entity ${who} Inventory`),
    vanilla(`data modify storage ${KEPT} ${id}.equipment set from entity ${who} equipment`),
  ]
}

/** Before putting back: no placeholder left from before, and the template, owned by `name`. */
export function putBackStart(name: string, id: string): [clean: Step, template: Step, owner: Step] {
  return [
    vanilla(`kill @e[type=minecraft:item,tag=${tag(id)}]`),
    vanilla(`data modify storage ${KEPT} ${id}.next set value {PickupDelay:0s,Tags:[]}`),
    vanilla(`data modify storage ${KEPT} ${id}.next.Owner set from entity ${safeName(name)} UUID`),
  ]
}

/**
 * One item back, from `path` under the kept id (`Inventory[0]`, `equipment.head`), in the order
 * they run: into the template (`copy`), the placeholder at their feet (`drop`), filled (`fill`),
 * and only then out of storage (`forget`), so a failure on the way never loses it.
 */
export function putBackItem(
  name: string,
  id: string,
  path: string,
): { copy: Step; drop: Step; fill: Step; forget: Step } {
  return {
    copy: vanilla(`data modify storage ${KEPT} ${id}.next.Item set from storage ${KEPT} ${id}.${path}`),
    drop: vanilla(
      `execute at ${safeName(name)} run summon minecraft:item ~ ~ ~ {Item:{id:"minecraft:barrier",count:1},Tags:["${tag(id)}"],PickupDelay:32767s}`,
    ),
    fill: vanilla(
      `data modify entity @e[type=minecraft:item,tag=${tag(id)},limit=1] {} merge from storage ${KEPT} ${id}.next`,
    ),
    forget: vanilla(`data remove storage ${KEPT} ${id}.${path}`),
  }
}

/** The whole copy gone: once it is all back, or no longer kept. */
export function forgetKept(id: string): Step {
  return vanilla(`data remove storage ${KEPT} ${id}`)
}

/**
 * What the game's answer to one of these means: `unknown` where the server doesn't know the
 * command by that name, `not_on` where the player or the placeholder isn't there, `gone` where the
 * storage holds nothing at that path (all of it back, or a world restored from before it was
 * kept), and `done` otherwise; "Nothing changed" is done, the value already as asked. Its words are
 * `en_us.json`'s (26.3's in the tests: `infra/fake/fake-minecraft/lang-26.3.json`).
 */
export function keptAnswer(answer: string): 'done' | 'unknown' | 'not_on' | 'gone' {
  const said = answer.trim()
  if (/^Unknown or incomplete command/.test(said)) return 'unknown'
  if (/^No (player|entity) was found/.test(said)) return 'not_on'
  if (/^Found no elements matching/.test(said)) return 'gone'
  return 'done'
}

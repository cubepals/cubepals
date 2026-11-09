// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The console commands behind the buttons on a player's page that owners would otherwise type: a
 * trip to a place or to another player, an item, health and hunger back, levels, a kick, an empty
 * inventory. Each is built here from checked values, never from text someone typed, and read back
 * from the game's answer (`powerAnswer`). Who may ask, and what is audited, is
 * `app/players/service.ts`'s; reading a player is `players.ts`'s.
 */
import { safeName } from './players.ts'

/** What the owner asked for: the page's choices, checked where they came in. */
export type PlayerPower =
  | { kind: 'teleport'; dimension: string; x: number; y: number | null; z: number }
  | { kind: 'to_player'; to: string }
  | { kind: 'give'; item: string; count: number }
  | { kind: 'heal' }
  | { kind: 'levels'; levels: number }
  | { kind: 'kick'; reason: string }
  | { kind: 'clear_inventory' }

/**
 * One command, in each of the ways to say it: the game's own by its full name first, since a
 * server's plugins may answer to the short one (EssentialsX's `give` and `tp` take other
 * arguments), then the short one vanilla knows. Whichever the server knows is enough.
 */
type Step = readonly string[]

const vanilla = (command: string): Step => [`minecraft:${command}`, command]

/**
 * The steps that do `power` to the player called `name`, in order; `to` names the player a trip to
 * another player goes to.
 */
export function powerSteps(name: string, power: PlayerPower, to?: string): Step[] {
  const player = safeName(name)
  switch (power.kind) {
    case 'teleport':
      return [teleportTo(player, power)]
    case 'to_player':
      return [vanilla(`tp ${player} ${safeName(to ?? '')}`)]
    case 'give':
      return [vanilla(`give ${player} ${itemId(power.item)} ${power.count}`)]
    case 'heal':
      // Instant health at level 6 heals 128 points, past any health; saturation at level 20
      // fills hunger in a tick. Neither shows particles.
      return [
        vanilla(`effect give ${player} minecraft:instant_health 1 5 true`),
        vanilla(`effect give ${player} minecraft:saturation 1 19 true`),
      ]
    case 'levels':
      return [vanilla(`experience add ${player} ${power.levels} levels`)]
    case 'kick': {
      const reason = power.reason.replace(/\p{Cc}/gu, ' ').trim()
      return [vanilla(reason === '' ? `kick ${player}` : `kick ${player} ${reason}`)]
    }
    case 'clear_inventory':
      return [vanilla(`clear ${player}`)]
  }
}

/**
 * To the block named, its middle; with no height, on whatever is highest there, as
 * `spreadplayers` stands a player, and in the Nether under its bedrock roof.
 */
function teleportTo(player: string, place: Extract<PlayerPower, { kind: 'teleport' }>): Step {
  const [x, z] = [place.x + 0.5, place.z + 0.5]
  if (place.y !== null) return [`execute in ${place.dimension} run tp ${player} ${x} ${place.y} ${z}`]
  const under = place.dimension === 'minecraft:the_nether' ? ' under 120' : ''
  return [`execute in ${place.dimension} run spreadplayers ${x} ${z} 0 1${under} false ${player}`]
}

/** `diamond` is `minecraft:diamond`, as the game reads it. */
function itemId(item: string): string {
  return item.includes(':') ? item : `minecraft:${item}`
}

/**
 * What the game's answer to one way of saying a step means: `unknown` where the server doesn't
 * know the command by that name and the next way is worth a try, `not_on` where the player isn't
 * there, `refused` where the game wouldn't (an item it doesn't know, more than it gives at once,
 * nowhere to stand), and `done` otherwise. Its words are its `en_us.json`'s, which a server's
 * console always speaks.
 */
export function powerAnswer(answer: string): 'done' | 'unknown' | 'not_on' | 'refused' {
  const said = answer.trim()
  if (/^Unknown or incomplete command/.test(said)) return 'unknown'
  if (/^No (player|entity) was found/.test(said)) return 'not_on'
  if (/^(Unknown item|Can't give more than|Could not spread|Incorrect argument|Invalid)/.test(said))
    return 'refused'
  return 'done'
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a player is told in chat when the server's owner acts on them from their page, so they know
 * why they moved or where an item came from: said at once, or as they join for what waited for
 * them, on a server that tells its players (`servers/tell-players.ts`, on until turned off). Not
 * for a kick, whose reason the game shows as it turns them out, or a game mode, which the game
 * announces itself. Who may act, and when, is `service.ts`'s; the line is `minecraft/console.ts`'s.
 */
import type { PlayerPower } from '@blockly/contracts'
import { keptPowers } from './kept-powers.ts'
import type { WaitingAction } from './persistence.ts'

const OWNER = 'The server’s owner'

/** The worlds every release has, as a sentence names them. */
const WORLDS: Record<string, string> = {
  'minecraft:overworld': 'the Overworld',
  'minecraft:the_nether': 'the Nether',
  'minecraft:the_end': 'the End',
}

/** What they are told of a power done to them now; `to` names whom a trip went to. Null: nothing. */
export function toldOfPower(power: PlayerPower, to?: string): string | null {
  switch (power.kind) {
    case 'teleport': {
      const at = power.y === null ? `${power.x}, ${power.z}` : `${power.x}, ${power.y}, ${power.z}`
      return `${OWNER} moved you to ${at} in ${WORLDS[power.dimension] ?? power.dimension}.`
    }
    case 'to_player':
      return to === undefined ? `${OWNER} moved you.` : `${OWNER} sent you to ${to}.`
    case 'give':
      return `${OWNER} gave you ${power.count} ${itemName(power.item)}.`
    case 'heal':
      return `${OWNER} healed and fed you.`
    case 'levels':
      return `${OWNER} gave you ${power.levels} ${power.levels === 1 ? 'level' : 'levels'}.`
    case 'clear_inventory':
      return `${OWNER} emptied your inventory. Cubepals kept what you had, so it can be put back.`
    case 'kick':
      return null
  }
}

/** What they are told of a trip back where they died, or to the spawn. */
export function toldOfTrip(to: 'death' | 'spawn'): string {
  return to === 'death' ? `${OWNER} took you back to where you died.` : `${OWNER} sent you to the spawn.`
}

export const TOLD_OF_PUT_BACK = `${OWNER} gave back what your inventory held. It is at your feet.`

/** What they are told as they join of one ask that waited for them and was done; null for nothing. */
export function toldOnJoin(action: Pick<WaitingAction, 'kind' | 'what'>): string | null {
  const told = toldOfWaiting(action)
  return told === null ? null : `While you were away, ${told.charAt(0).toLowerCase()}${told.slice(1)}`
}

function toldOfWaiting({ kind, what }: Pick<WaitingAction, 'kind' | 'what'>): string | null {
  if (kind === 'put_back') return TOLD_OF_PUT_BACK
  if (kind === 'game_mode') return null
  if (kind === 'place' && (what === 'death' || what === 'spawn')) return toldOfTrip(what)
  const powers = keptPowers(kind, what) ?? []
  if (kind !== 'give') return powers[0] === undefined ? null : toldOfPower(powers[0])
  const items = powers.flatMap((p) => (p.kind === 'give' ? [`${p.count} ${itemName(p.item)}`] : []))
  return items.length === 0 ? null : `${OWNER} gave you ${items.join(', ')}.`
}

/** `minecraft:golden_apple` reads "golden apple"; a mod's keeps its name: `create:wrench`. */
function itemName(id: string): string {
  const bare = id.includes(':') ? id : `minecraft:${id}`
  return bare.startsWith('minecraft:') ? bare.slice('minecraft:'.length).replaceAll('_', ' ') : bare
}

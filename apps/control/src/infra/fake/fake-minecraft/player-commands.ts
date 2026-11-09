// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Answers the commands a player's page sends for the owner (a trip to another player, an item, an
 * effect, levels, an emptied inventory) in vanilla's own words (its `en_us.json`), and moves a
 * player where a trip says. It keeps nothing else: what was sent is in the server's `heard`. Kicks
 * are `access-commands.ts`'s; trips to a place, `fake-minecraft.ts`'s.
 */

interface Place {
  dimension: string
  x: number
  y: number
  z: number
}

/** What these commands read and change on one server. */
export interface PlayerServer {
  online: Map<string, string>
  places: Map<string, Place>
}

/** The items the fake knows; any other is unknown to it, as a mod's item is to vanilla. */
const ITEMS = new Set(['minecraft:diamond', 'minecraft:bread', 'minecraft:torch', 'minecraft:oak_log'])
const NO_PLAYER = 'No player was found'
const NO_ENTITY = 'No entity was found'
const UNKNOWN = 'Unknown or incomplete command, see below for error'

const named = (server: PlayerServer, name: string) =>
  [...server.online].find(([, n]) => n === name)?.[0] ?? null

type Command = (server: PlayerServer, args: string[]) => string

const COMMANDS: Record<string, Command> = {
  tp(server, [who = '', to = '']) {
    const [mover, target] = [named(server, who), named(server, to)]
    if (mover === null || target === null) return NO_ENTITY
    const place = server.places.get(target) ?? { dimension: 'minecraft:overworld', x: 0, y: 64, z: 0 }
    server.places.set(mover, { ...place })
    return `Teleported ${who} to ${to}`
  },
  give(server, [who = '', item = '', count = '1']) {
    if (named(server, who) === null) return NO_PLAYER
    if (!ITEMS.has(item)) return `Unknown item '${item}'`
    if (Number(count) > 6400) return `Can't give more than 6400 of [${item}]`
    return `Gave ${count} [${item}] to ${who}`
  },
  effect(server, [give, who = '', effect = '']) {
    if (give !== 'give') return UNKNOWN
    return named(server, who) === null ? NO_ENTITY : `Applied effect ${effect} to ${who}`
  },
  experience(server, [add, who = '', levels = '0']) {
    if (add !== 'add') return UNKNOWN
    return named(server, who) === null ? NO_PLAYER : `Gave ${levels} experience levels to ${who}`
  },
  clear(server, [who = '']) {
    return named(server, who) === null ? NO_PLAYER : `No items were found on player ${who}`
  },
}

/** The answer to one of these commands; null for any other. */
export function playerCommand(server: PlayerServer, verb: string, args: string[]): string | null {
  return Object.hasOwn(COMMANDS, verb) ? (COMMANDS[verb]?.(server, args) ?? null) : null
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Answers the commands a player's page sends for the owner (a trip to another player, an item, an
 * effect, levels) in vanilla's own words: 26.3's language file, as the tests
 * of what they mean read it (`lang-26.3.json`, beside it). It moves a player where a
 * trip says. It keeps nothing else: what was sent is in the server's `heard`. Kicks
 * are `access-commands.ts`'s; trips to a place, `fake-minecraft.ts`'s; what players carry and an
 * emptied inventory, `inventories.ts`'s.
 */

import lang from './lang-26.3.json' with { type: 'json' }

/** A line of the game's, its `%s` filled in order. */
function said(key: keyof typeof lang.lines, ...values: string[]): string {
  let i = 0
  return lang.lines[key].replace(/%s/g, () => values[i++] ?? '')
}

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
const NO_PLAYER = said('argument.entity.notfound.player')
const NO_ENTITY = said('argument.entity.notfound.entity')
const UNKNOWN = said('command.unknown.command')

const named = (server: PlayerServer, name: string) =>
  [...server.online].find(([, n]) => n === name)?.[0] ?? null

type Command = (server: PlayerServer, args: string[]) => string

const COMMANDS: Record<string, Command> = {
  tp(server, [who = '', to = '']) {
    const [mover, target] = [named(server, who), named(server, to)]
    if (mover === null || target === null) return NO_ENTITY
    const place = server.places.get(target) ?? { dimension: 'minecraft:overworld', x: 0, y: 64, z: 0 }
    server.places.set(mover, { ...place })
    return said('commands.teleport.success.entity.single', who, to)
  },
  give(server, [who = '', item = '', count = '1']) {
    if (named(server, who) === null) return NO_PLAYER
    if (!ITEMS.has(item)) return said('argument.item.id.invalid', item)
    if (Number(count) > 6400) return said('commands.give.failed.toomanyitems', '6400', `[${item}]`)
    return said('commands.give.success.single', count, `[${item}]`, who)
  },
  effect(server, [give, who = '', effect = '']) {
    if (give !== 'give') return UNKNOWN
    return named(server, who) === null ? NO_ENTITY : said('commands.effect.give.success.single', effect, who)
  },
  experience(server, [add, who = '', levels = '0']) {
    if (add !== 'add') return UNKNOWN
    return named(server, who) === null
      ? NO_PLAYER
      : said('commands.experience.add.levels.success.single', levels, who)
  },
}

/** The answer to one of these commands; null for any other. */
export function playerCommand(server: PlayerServer, verb: string, args: string[]): string | null {
  return Object.hasOwn(COMMANDS, verb) ? (COMMANDS[verb]?.(server, args) ?? null) : null
}

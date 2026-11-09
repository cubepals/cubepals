// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each player carries on one fake server, and the world's own storage of emptied
 * inventories, answering the commands that read, keep, empty and put back an inventory
 * (`minecraft/kept-inventory.ts`) in 26.3's words (`lang-26.3.json`): `data get entity …
 * Inventory|equipment`, `data modify|remove storage …`, `kill`, `execute at … run summon`, the
 * fill that hands a placeholder its item, and `clear`. As on a 26.1 server with a player on: an
 * item entity summoned with `execute summon` and filled after is lost, so the fake only takes a
 * placeholder summoned whole; a filled one is picked up at once, into the first free slot.
 * Not trips, gifts or effects (`player-commands.ts`).
 */
import lang from './lang-26.3.json' with { type: 'json' }

export interface FakeItem {
  id: string
  count: number
}

interface Carried {
  inventory: (FakeItem & { slot: number })[]
  equipment: Record<string, FakeItem>
}

interface Kept {
  Inventory?: FakeItem[]
  equipment?: Record<string, FakeItem>
  next?: { Item?: FakeItem; Owner?: string }
}

function said(key: keyof typeof lang.lines, ...values: string[]): string {
  let i = 0
  return lang.lines[key].replace(/%s/g, () => values[i++] ?? '')
}

const UNKNOWN = said('command.unknown.command')
const NO_ENTITY = said('argument.entity.notfound.entity')
const STORAGE = 'blockly:kept'
const snbt = (item: FakeItem) => `{count: ${item.count}, id: "${item.id}"}`
/** "Diamond Sword", as the game names an item in its answers. */
const shown = (id: string) =>
  id
    .replace(/^minecraft:/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

export class FakeInventories {
  readonly #online: Map<string, string>
  readonly #carried = new Map<string, Carried>()
  readonly #kept = new Map<string, Kept>()
  readonly #placeholders = new Map<string, string>()

  /** `online` is the server's own: UUID to name. */
  constructor(online: Map<string, string>) {
    this.#online = online
  }

  /** What a player carries now: their inventory by slot, and what they wear. */
  carry(
    uuid: string,
    items: { inventory?: (FakeItem & { slot: number })[]; equipment?: Record<string, FakeItem> },
  ) {
    this.#carried.set(uuid, { inventory: [...(items.inventory ?? [])], equipment: { ...items.equipment } })
  }

  carried(uuid: string): Carried {
    return this.#of(uuid)
  }

  /** `data get entity <name> Inventory|equipment`, as SNBT; null where the field is empty or unknown. */
  field(uuid: string, field: string): string | null {
    const carried = this.#of(uuid)
    if (field === 'Inventory')
      return `[${carried.inventory.map((i) => `{count: ${i.count}, Slot: ${i.slot}b, id: "${i.id}"}`).join(', ')}]`
    if (field !== 'equipment') return null
    const worn = Object.entries(carried.equipment)
    return worn.length === 0 ? null : `{${worn.map(([slot, item]) => `${slot}: ${snbt(item)}`).join(', ')}}`
  }

  /** The answer to one of these commands; null for any other. */
  command(verb: string, args: string[]): string | null {
    if (verb === 'clear') return this.#clear(args[0] ?? '')
    if (verb === 'kill') return this.#kill(args[0] ?? '')
    if (verb === 'execute' && args[0] === 'at') return this.#summon(args)
    if (verb === 'data' && args[0] === 'remove' && args[1] === 'storage') return this.#remove(args[3] ?? '')
    if (verb === 'data' && args[0] === 'modify' && args[1] === 'storage') return this.#modify(args)
    if (verb === 'data' && args[0] === 'modify' && args[1] === 'entity') return this.#fill(args)
    return null
  }

  #clear(name: string): string {
    const uuid = this.#named(name)
    if (uuid === null) return said('argument.entity.notfound.player')
    const carried = this.#of(uuid)
    const items = [...carried.inventory, ...Object.values(carried.equipment)]
    if (items.length === 0) return said('clear.failed.single', name)
    this.#carried.set(uuid, { inventory: [], equipment: {} })
    return said('commands.clear.success.single', String(items.reduce((n, i) => n + i.count, 0)), name)
  }

  #kill(selector: string): string {
    const tag = /tag=([^,\]]+)/.exec(selector)?.[1] ?? ''
    if (!this.#placeholders.has(tag)) return NO_ENTITY
    this.#placeholders.delete(tag)
    return said('commands.kill.success.single', 'Barrier')
  }

  /** `execute at <name> run summon minecraft:item ~ ~ ~ {…Tags:["<tag>"]…}`: a placeholder by them. */
  #summon([, name = '', run, summon, type, , , , nbt = '']: string[]): string {
    if (run !== 'run' || summon !== 'summon' || type !== 'minecraft:item') return UNKNOWN
    const uuid = this.#named(name)
    if (uuid === null) return NO_ENTITY
    const tag = /Tags:\["([^"]+)"\]/.exec(nbt)?.[1]
    if (tag === undefined) return UNKNOWN
    this.#placeholders.set(tag, uuid)
    return said('commands.summon.success', 'Barrier')
  }

  /** `data modify entity @e[…tag=<tag>…] {} merge from storage blockly:kept <id>.next`: picked up at once. */
  #fill(args: string[]): string {
    const tag = /tag=([^,\]]+)/.exec(args[2] ?? '')?.[1] ?? ''
    const by = this.#placeholders.get(tag)
    if (by === undefined) return NO_ENTITY
    const next = this.#kept.get((args[8] ?? '').split('.')[0] ?? '')?.next
    const item = next?.Item
    if (item === undefined) return said('commands.data.entity.modified', 'Barrier')
    this.#placeholders.delete(tag)
    const owner = next?.Owner === undefined ? by : next.Owner
    const carried = this.#of(owner)
    const taken = new Set(carried.inventory.map((i) => i.slot))
    const slot = Array.from({ length: 36 }, (_, i) => i).find((i) => !taken.has(i)) ?? 0
    carried.inventory.push({ ...item, slot })
    return said('commands.data.entity.modified', shown(item.id))
  }

  #modify(args: string[]): string {
    const [, , storage, target = '', set, source, from, who = '', field = ''] = args
    if (storage !== STORAGE || set !== 'set') return UNKNOWN
    const [id = '', ...path] = target.split('.')
    const kept = this.#kept.get(id) ?? {}
    this.#kept.set(id, kept)
    if (source === 'value') {
      kept.next = {}
      return said('commands.data.storage.modified', STORAGE)
    }
    if (source !== 'from') return UNKNOWN
    if (from === 'entity') return this.#fromEntity(kept, path.join('.'), who, field)
    const item = this.#at(who === STORAGE ? field : '')
    if (item === undefined) return said('arguments.nbtpath.nothing_found', field)
    kept.next = { ...kept.next, Item: item }
    return said('commands.data.storage.modified', STORAGE)
  }

  #fromEntity(kept: Kept, path: string, name: string, field: string): string {
    const uuid = this.#named(name)
    if (uuid === null) return NO_ENTITY
    const carried = this.#of(uuid)
    if (path === 'next.Owner') kept.next = { ...kept.next, Owner: uuid }
    else if (path === 'Inventory') kept.Inventory = carried.inventory.map(({ id, count }) => ({ id, count }))
    else if (Object.keys(carried.equipment).length === 0)
      return said('arguments.nbtpath.nothing_found', field)
    else kept.equipment = { ...carried.equipment }
    return said('commands.data.storage.modified', STORAGE)
  }

  /** The item at `<id>.Inventory[0]` or `<id>.equipment.<slot>`. */
  #at(path: string): FakeItem | undefined {
    const [id = '', where = '', slot = ''] = path.split('.')
    const kept = this.#kept.get(id)
    if (where === 'Inventory[0]') return kept?.Inventory?.[0]
    return where === 'equipment' ? kept?.equipment?.[slot] : undefined
  }

  #remove(path: string): string {
    const [id = '', where, slot = ''] = path.split('.')
    const kept = this.#kept.get(id)
    if (kept === undefined || (where !== undefined && this.#at(path) === undefined))
      return said('commands.data.merge.failed')
    if (where === undefined) this.#kept.delete(id)
    else if (where === 'Inventory[0]') kept.Inventory?.shift()
    else delete kept.equipment?.[slot]
    return said('commands.data.storage.modified', STORAGE)
  }

  #named(name: string): string | null {
    for (const [uuid, named] of this.#online) if (named === name) return uuid
    return null
  }

  #of(uuid: string): Carried {
    const carried = this.#carried.get(uuid) ?? { inventory: [], equipment: {} }
    this.#carried.set(uuid, carried)
    return carried
  }
}

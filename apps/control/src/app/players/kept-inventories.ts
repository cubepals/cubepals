// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Emptying a player's inventory with a way back: before the game empties it, what they carry is
 * kept whole in the world (`minecraft/kept-inventory.ts`) and listed here, the newest few per
 * player, as the safety copies before a change are kept; putting one back drops it at their feet.
 * It never empties an inventory it couldn't keep first. For a player who is on, on a running
 * server; who may ask, the audit, and waiting for someone away are `service.ts`'s.
 */
import { randomBytes } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import type { ItemStackJson, Queryable } from '@blockly/db'
import type { Inventory } from '../../minecraft/items.ts'
import {
  EQUIPMENT_SLOTS,
  forgetKept,
  keepSteps,
  MOST_KEPT_ITEMS,
  putBackItem,
  putBackStart,
} from '../../minecraft/kept-inventory.ts'
import { powerSteps } from '../../minecraft/player-powers.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import { addKept, claimKept, dropIdleKept, dropKept, listKept, releaseKept } from './persistence.ts'
import type { PlayerReading } from './reading.ts'

/** How many emptied inventories are kept for each player, newest first. */
const KEPT_PER_PLAYER = 3
/** A put back that hasn't finished in this long was cut short, and may be asked for again. */
const PUTTING_BACK_STALE_MS = 10 * MINUTE_MS

/** `gone`: no longer kept (already back, or the world restored from before); `busy`: being put back. */
export type PutBackOutcome = 'done' | 'not_on' | 'failed' | 'gone' | 'busy'

interface Player {
  uuid: string
  name: string
}

export class KeptInventories {
  readonly #reading: PlayerReading

  /**
   * Each call reads and writes through the `q` it is given: a delivery's own transaction, which
   * holds its hold, so it never asks the pool for another connection while it keeps one.
   */
  constructor(deps: { reading: PlayerReading }) {
    this.#reading = deps.reading
  }

  /** Empties what `player` carries, keeping it first; the ender chest stays as it is. */
  async clear(
    q: Queryable,
    serverId: string,
    handle: RuntimeHandle,
    player: Player,
    requestedBy: string,
  ): Promise<'done' | 'not_on' | 'failed'> {
    const facts = await this.#reading.live(serverId, handle, player.name).catch(() => undefined)
    if (facts === undefined) return 'failed'
    if (facts === null) return 'not_on'
    const items = carried(facts.inventory)
    const id = items.length === 0 ? null : `k${randomBytes(6).toString('hex')}`
    if (id !== null) {
      const kept = await this.#keep(serverId, handle, player.name, id)
      if (kept !== 'done') return kept
      // Listed before the emptying, so a reply lost on the way never leaves the copy unlisted.
      await addKept(q, serverId, { id, playerUuid: player.uuid, keptAt: new Date(), requestedBy, items })
    }
    const cleared = await this.#reading.steps(
      serverId,
      handle,
      powerSteps(player.name, { kind: 'clear_inventory' }),
    )
    const outcome = cleared === 'failed' ? await this.#whetherEmptied(serverId, handle, player.name) : cleared
    if (outcome === 'done') {
      if (id !== null) await this.#trim(q, serverId, handle, player.uuid)
      return 'done'
    }
    // Not emptied, for certain: the copy would hand out a second set. Unknown: it stays, since a
    // second set can be cleared again and a lost one can't be had back.
    if (id !== null && outcome !== 'unknown') {
      await dropKept(q, serverId, id)
      await this.#forget(serverId, handle, id)
    }
    return outcome === 'not_on' ? 'not_on' : 'failed'
  }

  /**
   * After `clear` gave no answer: whether it emptied them all the same, read from what they carry
   * now. `unknown` where that can't be read either.
   */
  async #whetherEmptied(
    serverId: string,
    handle: RuntimeHandle,
    name: string,
  ): Promise<'done' | 'kept' | 'unknown'> {
    const facts = await this.#reading.live(serverId, handle, name).catch(() => null)
    if (facts === null) return 'unknown'
    return carried(facts.inventory).length === 0 ? 'done' : 'kept'
  }

  /** Puts the one kept as `id` back at `player`'s feet, every item of it, then forgets it. */
  async putBack(
    q: Queryable,
    serverId: string,
    handle: RuntimeHandle,
    player: Player,
    id: string,
  ): Promise<PutBackOutcome> {
    const now = new Date()
    const row = await claimKept(q, serverId, id, now, new Date(now.getTime() - PUTTING_BACK_STALE_MS))
    if (row === null) {
      const still = (await listKept(q, serverId, player.uuid)).some((k) => k.id === id)
      return still ? 'busy' : 'gone'
    }
    if (row.playerUuid !== player.uuid) {
      await releaseKept(q, serverId, id)
      return 'gone'
    }
    const outcome = await this.#handBack(serverId, handle, player.name, id)
    if (outcome === 'done' || outcome === 'gone') {
      await dropKept(q, serverId, id)
      await this.#forget(serverId, handle, id)
    } else await releaseKept(q, serverId, id)
    return outcome
  }

  /** The inventory, then what they wear: the inventory must be kept; the equipment may be empty. */
  async #keep(
    serverId: string,
    handle: RuntimeHandle,
    name: string,
    id: string,
  ): Promise<'done' | 'not_on' | 'failed'> {
    const [inventory, equipment] = keepSteps(name, id)
    const kept = await this.#reading.keptStep(serverId, handle, inventory)
    const worn = kept === 'done' ? await this.#reading.keptStep(serverId, handle, equipment) : kept
    if (worn === 'done' || worn === 'gone') return 'done'
    await this.#forget(serverId, handle, id)
    return worn === 'not_on' ? 'not_on' : 'failed'
  }

  /** Every item kept as `id`, one at a time; `gone` where the world held none of it. */
  async #handBack(
    serverId: string,
    handle: RuntimeHandle,
    name: string,
    id: string,
  ): Promise<Exclude<PutBackOutcome, 'busy'>> {
    const ready = await this.#begin(serverId, handle, name, id)
    if (ready !== 'done') return ready
    let given = 0
    for (let i = 0; i < MOST_KEPT_ITEMS; i++) {
      const outcome = await this.#one(serverId, handle, name, id, 'Inventory[0]')
      if (outcome === 'gone') break
      if (outcome !== 'done') return outcome
      given++
    }
    for (const slot of EQUIPMENT_SLOTS) {
      const outcome = await this.#one(serverId, handle, name, id, `equipment.${slot}`)
      if (outcome === 'gone') continue
      if (outcome !== 'done') return outcome
      given++
    }
    return given === 0 ? 'gone' : 'done'
  }

  /** No placeholder left from before, and the template the items are filled from. */
  async #begin(
    serverId: string,
    handle: RuntimeHandle,
    name: string,
    id: string,
  ): Promise<'done' | 'not_on' | 'failed'> {
    const [clean, template, owner] = putBackStart(name, id)
    // Nothing left to clean is the usual answer: only no answer at all stops it.
    if ((await this.#reading.keptStep(serverId, handle, clean)) === 'failed') return 'failed'
    if ((await this.#reading.keptStep(serverId, handle, template)) !== 'done') return 'failed'
    const owned = await this.#reading.keptStep(serverId, handle, owner)
    if (owned === 'done') return 'done'
    return owned === 'not_on' ? 'not_on' : 'failed'
  }

  /** One item back: out of storage only once it lies at their feet, so a failure never loses it. */
  async #one(
    serverId: string,
    handle: RuntimeHandle,
    name: string,
    id: string,
    path: string,
  ): Promise<'done' | 'not_on' | 'failed' | 'gone'> {
    const { copy, drop, fill, forget } = putBackItem(name, id, path)
    const copied = await this.#reading.keptStep(serverId, handle, copy)
    if (copied !== 'done') return copied === 'gone' ? 'gone' : 'failed'
    const dropped = await this.#reading.keptStep(serverId, handle, drop)
    if (dropped !== 'done') return dropped === 'not_on' ? 'not_on' : 'failed'
    if ((await this.#reading.keptStep(serverId, handle, fill)) !== 'done') return 'failed'
    return (await this.#reading.keptStep(serverId, handle, forget)) === 'done' ? 'done' : 'failed'
  }

  /**
   * The newest few for this player; the world forgets the rest, but never one being put back,
   * which goes once it is all back.
   */
  async #trim(q: Queryable, serverId: string, handle: RuntimeHandle, playerUuid: string): Promise<void> {
    const older = (await listKept(q, serverId, playerUuid)).slice(KEPT_PER_PLAYER)
    const stale = new Date(Date.now() - PUTTING_BACK_STALE_MS)
    for (const old of older)
      if (await dropIdleKept(q, serverId, old.id, stale)) await this.#forget(serverId, handle, old.id)
  }

  /** Best effort: a copy the world keeps that nothing lists is only a little storage. */
  async #forget(serverId: string, handle: RuntimeHandle, id: string): Promise<void> {
    await this.#reading.keptStep(serverId, handle, forgetKept(id)).catch(() => undefined)
  }
}

/** What `clear` takes: everything but the ender chest, as the page shows it. */
function carried(inventory: Inventory): ItemStackJson[] {
  const { head, chest, legs, feet } = inventory.armor
  return [...inventory.hotbar, ...inventory.main, head, chest, legs, feet, inventory.offhand].filter(
    (item) => item !== null,
  )
}

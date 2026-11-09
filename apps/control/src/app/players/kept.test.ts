// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Emptying an inventory with a way back: what a player carried is kept before it is emptied, and
 * never emptied when it couldn't be kept; it is put back at once for someone on, or as they next
 * join; the newest three are kept; one put back is gone from the list, and the world forgets it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  await h?.close()
})

const SWORD = { id: 'minecraft:diamond_sword', count: 1 }
const TORCHES = { id: 'minecraft:torch', count: 32 }
const HELMET = { id: 'minecraft:iron_helmet', count: 1 }

const carrying = async () => {
  const owner = await h.user()
  const { id } = await h.create(owner)
  await h.until(id, 'running')
  await h.settled(id)
  const kai = { uuid: randomUUID(), name: 'Kai' }
  h.minecraft.join(id, kai)
  await h.app.schedules.presenceSync()
  h.minecraft.inventories(id).carry(kai.uuid, {
    inventory: [
      { ...SWORD, slot: 0 },
      { ...TORCHES, slot: 1 },
    ],
    equipment: { head: HELMET },
  })
  return { owner, id, kai }
}

const items = (carried: { inventory: { id: string; count: number }[]; equipment: Record<string, unknown> }) =>
  carried.inventory.map(({ id, count }) => ({ id, count }))

describe.skipIf(!hasDatabase)('an emptied inventory, kept', () => {
  test('kept as it is emptied, and put back at once', async () => {
    const { owner, id, kai } = await carrying()
    expect(await h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })).toEqual({ done: 'now' })
    expect(h.minecraft.inventories(id).carried(kai.uuid)).toEqual({ inventory: [], equipment: {} })

    const [kept] = (await h.app.players.view(owner, id, kai.uuid)).kept
    expect(kept?.items.map((i) => i.id)).toEqual([SWORD.id, TORCHES.id, HELMET.id])

    expect(await h.app.players.putBack(owner, id, kai.uuid, kept?.id ?? '')).toEqual({ done: 'now' })
    expect(items(h.minecraft.inventories(id).carried(kai.uuid))).toEqual([SWORD, TORCHES, HELMET])
    expect((await h.app.players.view(owner, id, kai.uuid)).kept).toEqual([])
    await expect(h.app.players.putBack(owner, id, kai.uuid, kept?.id ?? '')).rejects.toThrow(
      'That was put back already.',
    )
  }, 30_000)

  test('never emptied when it couldn’t be kept', async () => {
    const { owner, id, kai } = await carrying()
    h.minecraft.refuseCommands(/data modify storage/)
    await expect(h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })).rejects.toThrow(
      'The server didn’t answer',
    )
    h.minecraft.refuseCommands(null)
    expect(items(h.minecraft.inventories(id).carried(kai.uuid))).toEqual([SWORD, TORCHES])
    expect(h.minecraft.heard(id)).not.toContain('clear Kai')
  }, 30_000)

  test('put back as they next join, and the newest three kept', async () => {
    const { owner, id, kai } = await carrying()
    await h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })
    for (let i = 0; i < 3; i++) {
      h.minecraft.inventories(id).carry(kai.uuid, { inventory: [{ ...TORCHES, slot: 0 }] })
      await h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })
    }
    const kept = (await h.app.players.view(owner, id, kai.uuid)).kept
    expect(kept.map((k) => k.items.length)).toEqual([1, 1, 1])

    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    const newest = kept[0]?.id ?? ''
    expect(await h.app.players.putBack(owner, id, kai.uuid, newest)).toEqual({ done: 'when_they_join' })
    expect((await h.app.players.view(owner, id, kai.uuid)).waiting).toEqual([
      expect.objectContaining({ kind: 'put_back', kept: newest }),
    ])

    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    expect(items(h.minecraft.inventories(id).carried(kai.uuid))).toEqual([TORCHES])
    const after = await h.app.players.view(owner, id, kai.uuid)
    expect(after.waiting).toEqual([])
    expect(after.kept.map((k) => k.id)).not.toContain(newest)
  }, 30_000)

  test('kept when the emptying ran but its answer was lost, and dropped when it didn’t run', async () => {
    const { owner, id, kai } = await carrying()
    h.minecraft.refuseCommands(/^clear /, { ranFirst: true })
    expect(await h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })).toEqual({ done: 'now' })
    h.minecraft.refuseCommands(null)
    expect(h.minecraft.inventories(id).carried(kai.uuid).inventory).toEqual([])
    const [kept] = (await h.app.players.view(owner, id, kai.uuid)).kept
    expect(kept?.items.map((i) => i.id)).toEqual([SWORD.id, TORCHES.id, HELMET.id])

    h.minecraft.inventories(id).carry(kai.uuid, { inventory: [{ ...TORCHES, slot: 0 }] })
    h.minecraft.refuseCommands(/^(minecraft:)?clear /)
    await expect(h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })).rejects.toThrow(
      'The server didn’t answer',
    )
    h.minecraft.refuseCommands(null)
    // Still carrying them: no second copy to hand out.
    expect((await h.app.players.view(owner, id, kai.uuid)).kept.map((k) => k.id)).toEqual([kept?.id ?? ''])
  }, 30_000)

  test('a queued emptying lists its copy before the game empties them', async () => {
    const { owner, id, kai } = await carrying()
    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    await h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })

    h.minecraft.join(id, kai)
    h.minecraft.slowCommands({ pattern: /^clear /, ms: 500 })
    const delivering = h.app.schedules.presenceSync()
    // While the game is still emptying them, the copy is already listed, from another connection.
    await waitFor(() => h.minecraft.heard(id).includes('clear Kai'))
    const rows = await h.db
      .select({ id: schema.playerInventoriesKept.id })
      .from(schema.playerInventoriesKept)
      .where(eq(schema.playerInventoriesKept.playerUuid, kai.uuid))
    expect(rows).toHaveLength(1)
    await delivering
    h.minecraft.slowCommands(null)
  }, 30_000)

  test('one being put back outlasts the newest three', async () => {
    const { owner, id, kai } = await carrying()
    await h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })
    const [oldest] = (await h.app.players.view(owner, id, kai.uuid)).kept
    await h.db
      .update(schema.playerInventoriesKept)
      .set({ puttingBackSince: new Date() })
      .where(eq(schema.playerInventoriesKept.id, oldest?.id ?? ''))
    for (let i = 0; i < 3; i++) {
      h.minecraft.inventories(id).carry(kai.uuid, { inventory: [{ ...TORCHES, slot: 0 }] })
      await h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })
    }
    expect((await h.app.players.view(owner, id, kai.uuid)).kept.map((k) => k.id)).toContain(oldest?.id ?? '')
  }, 30_000)
})

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10))
}

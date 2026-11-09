// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the owner does from a player's page instead of typing it into the console: done at once to
 * someone on, kept for someone away until they next join where it can wait, the game's refusals
 * told in the owner's words, only by the owner, and each audited.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  await h?.close()
})

const withPlayers = async () => {
  const owner = await h.user()
  const { id } = await h.create(owner)
  await h.until(id, 'running')
  await h.settled(id)
  const kai = { uuid: randomUUID(), name: 'Kai' }
  const ana = { uuid: randomUUID(), name: 'Ana' }
  h.minecraft.join(id, kai)
  h.minecraft.join(id, ana)
  await h.app.schedules.presenceSync()
  return { owner, id, kai, ana }
}

describe.skipIf(!hasDatabase)('powers on a player’s page', () => {
  test('done at once to someone on, and audited', async () => {
    const { owner, id, kai, ana } = await withPlayers()
    const act = (power: Parameters<typeof h.app.players.act>[3]) =>
      h.app.players.act(owner, id, kai.uuid, power)

    expect(await act({ kind: 'teleport', dimension: 'minecraft:the_nether', x: 5, y: 80, z: -2 })).toEqual({
      done: 'now',
    })
    expect(h.minecraft.placeOf(id, kai.uuid)).toEqual({
      dimension: 'minecraft:the_nether',
      x: 5.5,
      y: 80,
      z: -1.5,
    })
    expect(await act({ kind: 'to_player', to: ana.uuid })).toEqual({ done: 'now' })
    expect(await act({ kind: 'give', item: 'diamond', count: 3 })).toEqual({ done: 'now' })
    expect(await act({ kind: 'heal' })).toEqual({ done: 'now' })
    expect(await act({ kind: 'levels', levels: 5 })).toEqual({ done: 'now' })
    expect(await act({ kind: 'clear_inventory' })).toEqual({ done: 'now' })
    expect(await act({ kind: 'kick', reason: 'Time for bed' })).toEqual({ done: 'now' })
    expect(h.minecraft.kickedWith(id, kai.uuid)).toBe('Time for bed')
    expect(h.minecraft.heard(id)).toEqual(
      expect.arrayContaining(['give Kai minecraft:diamond 3', 'tp Kai Ana', 'experience add Kai 5 levels']),
    )

    const audits = await h.db
      .select({ data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'access.changed')))
    expect(audits.map((a) => (a.data as { power?: string }).power)).toEqual([
      'teleport',
      'to_player',
      'give',
      'heal',
      'levels',
      'clear_inventory',
      'kick',
    ])
    expect(audits[2]?.data).toEqual({
      player: kai,
      change: 'asked',
      power: 'give',
      item: 'diamond',
      count: '3',
    })
  }, 30_000)

  test('the game’s refusals, in the owner’s words', async () => {
    const { owner, id, kai } = await withPlayers()
    await expect(
      h.app.players.act(owner, id, kai.uuid, { kind: 'give', item: 'nope', count: 1 }),
    ).rejects.toThrow('Minecraft has no item called “nope” in this version.')
    await expect(h.app.players.act(owner, id, kai.uuid, { kind: 'to_player', to: kai.uuid })).rejects.toThrow(
      'Pick someone else who is playing now.',
    )
  }, 30_000)
})

describe.skipIf(!hasDatabase)('powers for someone away', () => {
  test('nothing for anyone but the owner, and no heal or kick for someone away', async () => {
    const { owner, id, kai } = await withPlayers()
    const stranger = await h.user('stranger')
    await expect(h.app.players.act(stranger, id, kai.uuid, { kind: 'heal' })).rejects.toThrow(
      'Server was not found',
    )
    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    await expect(h.app.players.act(owner, id, kai.uuid, { kind: 'heal' })).rejects.toThrow(
      'Kai isn’t playing just now.',
    )
    await expect(h.app.players.act(owner, id, kai.uuid, { kind: 'kick', reason: '' })).rejects.toThrow(
      'Kai isn’t playing just now.',
    )
    expect((await h.app.players.view(owner, id, kai.uuid)).waiting).toEqual([])
  }, 30_000)

  test('kept for someone away, added up, and done as they next join', async () => {
    const { owner, id, kai } = await withPlayers()
    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    const act = (power: Parameters<typeof h.app.players.act>[3]) =>
      h.app.players.act(owner, id, kai.uuid, power)

    const later = { done: 'when_they_join' } as const
    expect(await act({ kind: 'give', item: 'diamond', count: 3 })).toEqual(later)
    expect(await act({ kind: 'give', item: 'minecraft:diamond', count: 2 })).toEqual(later)
    expect(await act({ kind: 'give', item: 'torch', count: 16 })).toEqual(later)
    expect(await act({ kind: 'levels', levels: 5 })).toEqual(later)
    expect(await act({ kind: 'levels', levels: 3 })).toEqual(later)
    expect(await act({ kind: 'clear_inventory' })).toEqual(later)
    expect(await act({ kind: 'teleport', dimension: 'minecraft:the_end', x: 1, y: 70, z: 2 })).toEqual(later)
    await expect(act({ kind: 'levels', levels: 1000 })).rejects.toThrow('more than Minecraft hands over')

    const waiting = (await h.app.players.view(owner, id, kai.uuid)).waiting
    expect(waiting).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'give',
          items: [
            { item: 'minecraft:diamond', count: 5 },
            { item: 'minecraft:torch', count: 16 },
          ],
        }),
        expect.objectContaining({ kind: 'levels', levels: 8 }),
        expect.objectContaining({ kind: 'clear_inventory' }),
        expect.objectContaining({
          kind: 'place',
          what: 'there',
          there: { dimension: 'minecraft:the_end', x: 1, y: 70, z: 2 },
        }),
      ]),
    )
    await h.app.players.cancel(owner, id, kai.uuid, 'clear_inventory')
    await act({ kind: 'clear_inventory' })

    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    expect((await h.app.players.view(owner, id, kai.uuid)).waiting).toEqual([])
    expect(h.minecraft.placeOf(id, kai.uuid)).toEqual({
      dimension: 'minecraft:the_end',
      x: 1.5,
      y: 70,
      z: 2.5,
    })
    // Emptied first, so what was given after stays.
    const heard = h.minecraft.heard(id)
    const at = (said: string) => heard.lastIndexOf(said)
    expect(at('clear Kai')).toBeGreaterThan(-1)
    expect(at('clear Kai')).toBeLessThan(at('give Kai minecraft:diamond 5'))
    expect(at('give Kai minecraft:torch 16')).toBeGreaterThan(-1)
    expect(at('experience add Kai 8 levels')).toBeGreaterThan(-1)

    const audits = await h.db
      .select({ data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'access.changed')))
    expect(
      audits.map((a) => a.data).filter((d) => (d as { change?: string }).change === 'done_on_join'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'give', what: expect.stringContaining('minecraft:torch') }),
        expect.objectContaining({ kind: 'levels', what: '8' }),
      ]),
    )
  }, 30_000)
})

describe.skipIf(!hasDatabase)('kept powers across a retry or a sleep', () => {
  test('items wait while an emptying waits for a retry, so the emptying still comes first', async () => {
    const { owner, id, kai } = await withPlayers()
    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    await h.app.players.act(owner, id, kai.uuid, { kind: 'clear_inventory' })
    await h.app.players.act(owner, id, kai.uuid, { kind: 'give', item: 'diamond', count: 2 })

    // They carry something, so an emptying that didn't run has left it there.
    h.minecraft.inventories(id).carry(kai.uuid, { inventory: [{ id: 'minecraft:bread', count: 1, slot: 0 }] })
    h.minecraft.refuseCommands(/^(minecraft:)?clear /)
    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    expect(h.minecraft.heard(id)).not.toContain('give Kai minecraft:diamond 2')
    expect((await h.app.players.view(owner, id, kai.uuid)).waiting.map((w) => w.kind).sort()).toEqual([
      'clear_inventory',
      'give',
    ])

    // Asked for now, while the emptying still waits: it waits behind it.
    expect(await h.app.players.act(owner, id, kai.uuid, { kind: 'give', item: 'diamond', count: 1 })).toEqual(
      {
        done: 'when_they_join',
      },
    )
    expect(h.minecraft.heard(id)).not.toContain('give Kai minecraft:diamond 3')

    h.minecraft.refuseCommands(null)
    await h.app.schedules.presenceSync()
    const heard = h.minecraft.heard(id)
    expect(heard.lastIndexOf('clear Kai')).toBeLessThan(heard.lastIndexOf('give Kai minecraft:diamond 3'))
    expect((await h.app.players.view(owner, id, kai.uuid)).waiting).toEqual([])
  }, 30_000)

  test('given once when a reading and an ask deliver at the same time', async () => {
    const { owner, id, kai } = await withPlayers()
    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    await h.app.players.act(owner, id, kai.uuid, { kind: 'give', item: 'diamond', count: 5 })

    h.minecraft.join(id, kai)
    // Seen on, but not yet delivered to: both asks find the diamonds waiting, and the first give is
    // slow, so the second delivery starts while the first is still giving.
    h.minecraft.refuseCommands(/^(minecraft:)?give /)
    await h.app.schedules.presenceSync()
    h.minecraft.refuseCommands(null)
    h.minecraft.slowCommands({ pattern: /^(minecraft:)?give /, ms: 300 })
    await Promise.all([
      h.app.players.act(owner, id, kai.uuid, { kind: 'levels', levels: 1 }),
      h.app.players.act(owner, id, kai.uuid, { kind: 'levels', levels: 2 }),
      h.app.schedules.presenceSync(),
    ])
    h.minecraft.slowCommands(null)
    expect(h.minecraft.heard(id).filter((c) => c === 'give Kai minecraft:diamond 5')).toHaveLength(1)
  }, 30_000)

  test('kept while the server sleeps', async () => {
    const { owner, id, kai } = await withPlayers()
    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    expect(await h.app.players.act(owner, id, kai.uuid, { kind: 'give', item: 'diamond', count: 1 })).toEqual(
      {
        done: 'when_they_join',
      },
    )
    await expect(h.app.players.act(owner, id, kai.uuid, { kind: 'heal' })).rejects.toThrow(
      'Start the server to do this.',
    )
  }, 60_000)
})

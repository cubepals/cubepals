// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the owner does from a player's page instead of typing it into the console: done at once to
 * someone on, refused for someone away, the game's refusals told in the owner's words, only by the
 * owner, and each audited.
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

  test('nothing for someone away, and nothing for anyone but the owner', async () => {
    const { owner, id, kai } = await withPlayers()
    const stranger = await h.user('stranger')
    await expect(h.app.players.act(stranger, id, kai.uuid, { kind: 'heal' })).rejects.toThrow(
      'Server was not found',
    )
    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    await expect(h.app.players.act(owner, id, kai.uuid, { kind: 'heal' })).rejects.toThrow(
      'They aren’t playing just now.',
    )
  }, 30_000)
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One player's page: read from the game while they are on, from their files while they are away,
 * and from what was kept when the server went to sleep; changes done now, or kept until they join
 * and done then, or taken back; only by the owner, and each audited.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import type { FakeGround } from '../../infra/fake/fake-minecraft.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

/** A real 1.20.1 player's files: creative, last died at 12 -60 34 in the Overworld, a named sword. */
const FIXTURES = `${import.meta.dir}/../../minecraft/player-fixtures/1.20.1`

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  await h?.close()
})

const running = async () => {
  const owner = await h.user()
  const created = await h.create(owner)
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return { owner, id: created.id }
}
/** The player's files on the server's volume, as the game saved them. */
const saveFiles = async (id: string, uuid: string) => {
  for (const [from, to] of [
    ['player.dat', `world/playerdata/${uuid}.dat`],
    ['stats.json', `world/stats/${uuid}.json`],
    ['level.dat', 'world/level.dat'],
  ] as const) {
    const path = h.minecraft.path(id, to)
    await mkdir(dirname(path), { recursive: true })
    await copyFile(`${FIXTURES}/${from}`, path)
  }
}
const audited = (id: string) =>
  h.db
    .select({ actor: schema.auditLog.actor, data: schema.auditLog.data })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.subjectId, id),
        eq(schema.auditLog.action, 'access.changed'),
        sql`${schema.auditLog.data} ? 'player'`,
      ),
    )

describe.skipIf(!hasDatabase)('a player on, and one away', () => {
  test('someone on: read from the game, sent back where they died and given a mode at once', async () => {
    const { owner, id } = await running()
    const kai = { uuid: randomUUID(), name: 'Kai' }
    h.minecraft.join(id, kai)
    h.minecraft.die(id, kai.uuid, { dimension: 'minecraft:the_nether', x: 12, y: 70, z: 34 })
    h.minecraft.ground(id, { dimension: 'minecraft:the_nether', x: 12, z: 34 }, 70)
    await h.app.schedules.presenceSync()
    await saveFiles(id, kai.uuid)

    const page = await h.app.players.view(owner, id, kai.uuid)
    expect(page).toMatchObject({
      name: 'Kai',
      online: true,
      source: 'live',
      position: { dimension: 'minecraft:overworld', x: 0, y: 64, z: 0 },
      lastDeath: { dimension: 'minecraft:the_nether', x: 12, y: 70, z: 34 },
      gameMode: 'survival',
      waiting: [],
    })

    expect(await h.app.players.teleport(owner, id, kai.uuid, 'death')).toEqual({ done: 'now' })
    expect(h.minecraft.placeOf(id, kai.uuid)).toEqual({
      dimension: 'minecraft:the_nether',
      x: 12.5,
      y: 70,
      z: 34.5,
    })
    expect(await h.app.players.setGameMode(owner, id, kai.uuid, 'creative')).toEqual({ done: 'now' })
    expect(h.minecraft.playing(id).modes).toEqual({ Kai: 'creative' })
    expect(await h.app.players.teleport(owner, id, kai.uuid, 'spawn')).toEqual({ done: 'now' })
    expect(h.minecraft.placeOf(id, kai.uuid)).toMatchObject({ dimension: 'minecraft:overworld', y: 64 })

    // Who, which player and what, each time.
    expect(await audited(id)).toEqual([
      { actor: `user:${owner.userId}`, data: { player: kai, change: 'asked', kind: 'place', what: 'death' } },
      {
        actor: `user:${owner.userId}`,
        data: { player: kai, change: 'asked', kind: 'game_mode', what: 'creative' },
      },
      { actor: `user:${owner.userId}`, data: { player: kai, change: 'asked', kind: 'place', what: 'spawn' } },
    ])
  }, 30_000)

  test('someone away: read from their files; a trip waits for them, can be taken back, and happens as they join', async () => {
    const { owner, id } = await running()
    const kai = { uuid: randomUUID(), name: 'Kai' }
    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    await saveFiles(id, kai.uuid)

    const page = await h.app.players.view(owner, id, kai.uuid)
    expect(page).toMatchObject({
      online: false,
      source: 'files',
      gameMode: 'creative',
      lastDeath: { dimension: 'minecraft:overworld', x: 12, y: -60, z: 34 },
      stats: { deaths: 2 },
    })
    expect(page.inventory?.hotbar[0]).toMatchObject({ name: 'Ow', enchantments: ['Sharpness III'] })

    expect(await h.app.players.teleport(owner, id, kai.uuid, 'death')).toEqual({ done: 'when_they_join' })
    expect(await h.app.players.setGameMode(owner, id, kai.uuid, 'survival')).toEqual({
      done: 'when_they_join',
    })
    expect((await h.app.players.view(owner, id, kai.uuid)).waiting.map((w) => w.what).sort()).toEqual([
      'death',
      'survival',
    ])
    // Taken back: the mode no longer waits; the trip still does.
    await h.app.players.cancel(owner, id, kai.uuid, 'game_mode')
    expect((await h.app.players.view(owner, id, kai.uuid)).waiting.map((w) => w.what)).toEqual(['death'])

    // They join, and they died somewhere since: the trip goes where they died last.
    h.minecraft.join(id, kai)
    h.minecraft.die(id, kai.uuid, { dimension: 'minecraft:overworld', x: -40, y: 12, z: 7 })
    h.minecraft.ground(id, { dimension: 'minecraft:overworld', x: -40, z: 7 }, 12)
    await h.app.schedules.presenceSync()
    expect(h.minecraft.placeOf(id, kai.uuid)).toEqual({
      dimension: 'minecraft:overworld',
      x: -39.5,
      y: 12,
      z: 7.5,
    })
    expect(h.minecraft.playing(id).modes).toEqual({ Kai: 'survival' })
    expect((await h.app.players.view(owner, id, kai.uuid)).waiting).toEqual([])
    const trail = (await audited(id)).map((row) => (row.data as { change: string }).change)
    expect(trail).toEqual(['asked', 'asked', 'cancelled', 'done_on_join'])
    expect((await audited(id)).at(-1)?.actor).toBe('system:access')
  }, 30_000)
})

/** Every column within `radius` of a point topped the same: lava, nothing at all, magma… */
const pour = (
  id: string,
  at: { dimension: string; x: number; z: number },
  radius: number,
  top: FakeGround,
) => {
  for (let x = at.x - radius; x <= at.x + radius; x++)
    for (let z = at.z - radius; z <= at.z + radius; z++) h.minecraft.ground(id, { ...at, x, z }, top)
}

describe.skipIf(!hasDatabase)('back where they died, standing somewhere safe', () => {
  test('died in a cave: they stand on the highest block above it, and are told where', async () => {
    const { owner, id } = await running()
    const kai = { uuid: randomUUID(), name: 'Kai' }
    h.minecraft.join(id, kai)
    h.minecraft.die(id, kai.uuid, { dimension: 'minecraft:overworld', x: 5, y: 12, z: -9 })
    h.minecraft.ground(id, { dimension: 'minecraft:overworld', x: 5, z: -9 }, 71)
    await h.app.schedules.presenceSync()

    expect(await h.app.players.teleport(owner, id, kai.uuid, 'death')).toEqual({
      done: 'now',
      note: 'Kai is on safe ground 59 blocks from where they died, at 5, 71, -9.',
    })
    expect(h.minecraft.placeOf(id, kai.uuid)).toEqual({
      dimension: 'minecraft:overworld',
      x: 5.5,
      y: 71,
      z: -8.5,
    })
  }, 30_000)

  test('died in lava: beside the pool, and in a lake of it, the spawn, saying so', async () => {
    const { owner, id } = await running()
    const kai = { uuid: randomUUID(), name: 'Kai' }
    h.minecraft.join(id, kai)
    await saveFiles(id, kai.uuid)
    const death = { dimension: 'minecraft:the_nether', x: 40, y: 31, z: 40 }
    h.minecraft.die(id, kai.uuid, death)
    pour(id, death, 2, 'lava')
    await h.app.schedules.presenceSync()

    expect(await h.app.players.teleport(owner, id, kai.uuid, 'death')).toEqual({
      done: 'now',
      note: expect.stringMatching(
        /^Kai is on safe ground \d+ blocks from where they died, at -?\d+, 64, -?\d+\.$/,
      ),
    })
    const beside = h.minecraft.placeOf(id, kai.uuid)
    expect(beside).toMatchObject({ dimension: 'minecraft:the_nether', y: 64 })
    const off = Math.max(Math.abs((beside?.x ?? 0) - 40.5), Math.abs((beside?.z ?? 0) - 40.5))
    expect(off).toBe(3)

    pour(id, death, 20, 'lava')
    expect(await h.app.players.teleport(owner, id, kai.uuid, 'death')).toEqual({
      done: 'now',
      note: 'There was nowhere safe to stand near where Kai died, so they went to the spawn.',
    })
    expect(h.minecraft.placeOf(id, kai.uuid)).toMatchObject({ dimension: 'minecraft:overworld', y: 64 })
    // The page still says where they died.
    expect((await h.app.players.view(owner, id, kai.uuid)).lastDeath).toEqual(death)
  }, 30_000)

  test('died on a cactus: off it, beside it; in a field of magma, the spawn, saying so', async () => {
    const { owner, id } = await running()
    const kai = { uuid: randomUUID(), name: 'Kai' }
    h.minecraft.join(id, kai)
    await saveFiles(id, kai.uuid)
    const death = { dimension: 'minecraft:overworld', x: 200, y: 65, z: 200 }
    h.minecraft.die(id, kai.uuid, death)
    // The game would stand them on top of it: the trip looks again, and lands beside it.
    h.minecraft.ground(id, death, { on: 'minecraft:cactus', y: 67 })
    await h.app.schedules.presenceSync()

    expect(await h.app.players.teleport(owner, id, kai.uuid, 'death')).toEqual({ done: 'now' })
    const beside = h.minecraft.placeOf(id, kai.uuid)
    expect(beside).toMatchObject({ dimension: 'minecraft:overworld', y: 64 })
    const off = Math.max(Math.abs((beside?.x ?? 0) - 200.5), Math.abs((beside?.z ?? 0) - 200.5))
    expect(off).toBe(1)

    // Everywhere near is magma, which the game would stand them on every time.
    pour(id, death, 20, { on: 'minecraft:magma_block', y: 64 })
    expect(await h.app.players.teleport(owner, id, kai.uuid, 'death')).toEqual({
      done: 'now',
      note: 'There was nowhere safe to stand near where Kai died, so they went to the spawn.',
    })
    expect(h.minecraft.placeOf(id, kai.uuid)).toMatchObject({ dimension: 'minecraft:overworld', y: 64 })
    expect(Math.abs(h.minecraft.placeOf(id, kai.uuid)?.x ?? 200)).toBeLessThan(2)
  }, 30_000)

  test('fell into the void: the spawn, now or as they next join, and the audit says so', async () => {
    const { owner, id } = await running()
    const kai = { uuid: randomUUID(), name: 'Kai' }
    h.minecraft.join(id, kai)
    await saveFiles(id, kai.uuid)
    const death = { dimension: 'minecraft:the_end', x: 300, y: -70, z: -20 }
    pour(id, death, 20, 'void')
    h.minecraft.die(id, kai.uuid, death)
    await h.app.schedules.presenceSync()

    expect(await h.app.players.teleport(owner, id, kai.uuid, 'death')).toMatchObject({
      done: 'now',
      note: expect.stringContaining('went to the spawn'),
    })
    expect(h.minecraft.placeOf(id, kai.uuid)).toMatchObject({ dimension: 'minecraft:overworld' })

    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    expect(await h.app.players.teleport(owner, id, kai.uuid, 'death')).toEqual({ done: 'when_they_join' })
    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    expect((await h.app.players.view(owner, id, kai.uuid)).waiting).toEqual([])
    expect((await audited(id)).at(-1)?.data).toMatchObject({ change: 'done_on_join', instead: 'spawn' })
  }, 30_000)
})

describe.skipIf(!hasDatabase)('a sleeping server, and who may ask', () => {
  test('asleep: the snapshot kept as it stopped, and asks wait for its next run', async () => {
    const { owner, id } = await running()
    const kai = { uuid: randomUUID(), name: 'Kai' }
    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    h.minecraft.leave(id, kai.uuid)
    await saveFiles(id, kai.uuid)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')

    const kept = await h.db
      .select()
      .from(schema.serverPlayerSnapshots)
      .where(eq(schema.serverPlayerSnapshots.serverId, id))
    expect(kept.map((row) => row.playerUuid)).toEqual([kai.uuid])
    const page = await h.app.players.view(owner, id, kai.uuid)
    expect(page).toMatchObject({
      source: 'snapshot',
      online: false,
      gameMode: 'creative',
      lastDeath: { x: 12, y: -60, z: 34 },
      stats: { deaths: 2 },
    })
    expect(page.asOf).toBe(kept[0]?.takenAt.toISOString() ?? '')
    expect(page.inventory?.enderChest[0]).toMatchObject({ id: 'minecraft:diamond', count: 12 })
    expect(await h.app.players.teleport(owner, id, kai.uuid, 'spawn')).toEqual({ done: 'when_they_join' })
  }, 60_000)

  test('only the owner: anyone else finds no such server, and nothing is asked or audited', async () => {
    const { owner, id } = await running()
    const kai = { uuid: randomUUID(), name: 'Kai' }
    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    const stranger = await h.user('stranger')
    await expect(h.app.players.view(stranger, id, kai.uuid)).rejects.toThrow('Server was not found')
    await expect(h.app.players.teleport(stranger, id, kai.uuid, 'spawn')).rejects.toThrow(
      'Server was not found',
    )
    await expect(h.app.players.cancel(stranger, id, kai.uuid, 'place')).rejects.toThrow(
      'Server was not found',
    )
    // Nobody who never played here or was listed has a page.
    await expect(h.app.players.view(owner, id, randomUUID())).rejects.toThrow('Player was not found')
    expect(await audited(id)).toEqual([])
  }, 30_000)
})

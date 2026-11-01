// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Updating a real server preserves its world, settings and usage through success and rollback. */
import { describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { asc, eq } from 'drizzle-orm'
import type { ServerSettings } from '../../../domain/revision/revision.ts'
import { hasDatabase, startHarness } from '../../../testing/harness.ts'
import { loadRevision, loadRuntime } from '../../servers/persistence.ts'

async function fixture(gameVersion = '26.3') {
  const h = await startHarness()
  try {
    const owner = await h.user('Steve', 'plus')
    const created = await h.create(owner, { gameVersion })
    const server = await h.until(created.id, 'running')
    await h.settled(server.id)
    const change = async (patch: Partial<ServerSettings>) => {
      const current = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
      return h.app.revisions.changeSettings(
        owner,
        server.id,
        { ...current.settings, ...patch },
        crypto.randomUUID(),
      )
    }
    const applied = async () => (await h.settled(server.id)).filter((op) => op.kind === 'apply').at(-1)
    return { h, owner, server, change, applied }
  } catch (error) {
    await h.close()
    throw error
  }
}

async function liveSettings() {
  const { h, server, change, applied } = await fixture()
  try {
    const before = h.runtime.machine(server.id)?.spec.env.DIFFICULTY
    await change({ difficulty: 'hard', pvp: false })
    expect((await applied())?.status).toBe('succeeded')
    expect(h.minecraft.playing(server.id)).toMatchObject({ difficulty: 'hard', pvp: false })
    expect(h.runtime.machine(server.id)?.spec.env.DIFFICULTY).toBe(before)
    expect((await loadRuntime(h.db, server.id, ['fake'])).applied?.revisionId).toBe(
      (await h.server(server.id)).desiredRevisionId,
    )
  } finally {
    await h.close()
  }
}

async function settingsBoot() {
  const { h, server, change, applied } = await fixture()
  try {
    await change({ spawnProtection: 4 })
    expect((await applied())?.status).toBe('succeeded')
    expect(await h.minecraft.file(server.id, 'server.properties')).toContain('spawn-protection=4')
    expect((await h.server(server.id)).lifecycle.status).toBe('running')
    expect((await loadRuntime(h.db, server.id, ['fake'])).applied?.revisionId).toBe(
      (await h.server(server.id)).desiredRevisionId,
    )
    expect(
      await h.db.select().from(schema.backups).where(eq(schema.backups.serverId, server.id)),
    ).toHaveLength(0)
  } finally {
    await h.close()
  }
}

async function settingsRollback() {
  const { h, server, change, applied } = await fixture()
  try {
    h.runtime.failBootWhen((spec) =>
      spec.env.SPAWN_PROTECTION === '4' ? 'The changed process refused to boot' : null,
    )
    await change({ spawnProtection: 4 })
    const result = await applied()
    expect(result?.status).toBe('failed')
    expect(result?.step).toBe('rolling_back')
    expect(result?.error).toContain("didn't start")
    expect((await h.server(server.id)).lifecycle.status).toBe('running')
    expect((await h.server(server.id)).desiredRevisionId).toBe(server.desiredRevisionId)
    expect(await h.minecraft.file(server.id, 'server.properties')).toContain('spawn-protection=0')
  } finally {
    h.runtime.failBootWhen(() => null)
    await h.close()
  }
}

async function versionBoot() {
  const { h, owner, server, applied } = await fixture('26.2')
  try {
    await h.app.mods.changeVersion(
      owner,
      server.id,
      { gameVersion: '26.3', loader: 'vanilla' },
      [],
      crypto.randomUUID(),
    )
    expect((await applied())?.status).toBe('succeeded')
    expect((await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)).gameVersion).toBe('26.3')
    const copies = await h.db.select().from(schema.backups).where(eq(schema.backups.serverId, server.id))
    expect(copies.some((copy) => copy.trigger === 'pre_apply' && copy.status === 'ready')).toBe(true)
    expect((await h.server(server.id)).lifecycle.status).toBe('running')
  } finally {
    await h.close()
  }
}

async function versionRollback() {
  const { h, owner, server, applied } = await fixture('26.2')
  try {
    h.minecraft.breakOn((env) => (env.VERSION === '26.3' ? 'The upgraded world cannot load' : null))
    await h.app.mods.changeVersion(
      owner,
      server.id,
      { gameVersion: '26.3', loader: 'vanilla' },
      [],
      crypto.randomUUID(),
    )
    expect((await applied())?.status).toBe('failed')
    expect((await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)).gameVersion).toBe('26.2')
    expect((await h.server(server.id)).lifecycle.status).toBe('running')
    const [world] = await h.db.select().from(schema.worlds).where(eq(schema.worlds.serverId, server.id))
    if (!world) throw new Error('The world must remain recorded')
    expect(await h.minecraft.file(server.id, `${world.levelName}/level.dat`)).toBe(
      'opened by 26.2\nopened by 26.2\n',
    )
  } finally {
    h.minecraft.breakOn(() => null)
    await h.close()
  }
}

async function resizeUsage() {
  const { h, owner, server, applied } = await fixture()
  try {
    await h.app.revisions.resize(owner, server.id, '4g', crypto.randomUUID())
    expect((await applied())?.status).toBe('succeeded')
    expect((await h.server(server.id)).memoryTier).toBe('4g')
    expect(h.runtime.machine(server.id)?.spec.resources.memoryMb).toBe(4096)
    const intervals = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, server.id))
      .orderBy(asc(schema.powerIntervals.startedAt))
    expect(intervals.map((interval) => [interval.memoryTier, interval.stoppedAt === null])).toEqual([
      ['3g', false],
      ['4g', true],
    ])
  } finally {
    await h.close()
  }
}

describe.skipIf(!hasDatabase)('updating a running server', () => {
  test('takes live settings without restarting', liveSettings, 30 * SECOND_MS)
  test('boots into startup settings without copying the world', settingsBoot, 30 * SECOND_MS)
  test('puts the running configuration back after a refused boot', settingsRollback, 30 * SECOND_MS)
  test('copies the world before upgrading Minecraft', versionBoot, 30 * SECOND_MS)
  test('restores the copied world after an upgrade cannot load it', versionRollback, 30 * SECOND_MS)
  test('ends the old usage interval when changing memory size', resizeUsage, 30 * SECOND_MS)
})

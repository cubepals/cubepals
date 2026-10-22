// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bedrock players on plain Minecraft: Survival, Creative and Hardcore run on Paper with Bedrock on
 * from the start, and a plain server made before that keeps what it had until its owner takes the
 * one step that lets Bedrock friends in, which moves it onto Paper where it isn't, a backup first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { runsOnPaper } from '../../domain/revision/revision.ts'
import { FakeGeyserMc } from '../../infra/fake/fake-geysermc.ts'
import { FLOODGATE } from '../../minecraft/bedrock.ts'
import { VIABACKWARDS, VIAVERSION } from '../../minecraft/mods.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { AppError } from '../errors.ts'
import { loadRevision } from '../servers/persistence.ts'

let h: Harness
const geyser = new FakeGeyserMc()
/** A key for tests: 16 bytes as base64, nothing a deployment uses. */
const TEST_FLOODGATE_KEY = Buffer.alloc(16, 9).toString('base64')
const cdn = new Cdn()

const via = (projectId: string, name: string) =>
  h.catalog.publish(
    {
      projectId,
      slug: projectId,
      name,
      summary: '',
      iconUrl: null,
      environments: ['server_only'],
      downloads: 1,
    },
    [
      {
        versionId: `${projectId}-1`,
        projectId,
        versionLabel: '5.0',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['paper', 'spigot'],
        gameVersions: offeredVersions().map((offered) => offered.id),
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file: cdn.file(`${projectId}-1`),
        dependencies: [],
      },
    ],
  )

beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness({
    capabilities: { archives: null, billing: null, bedrock: { floodgateKey: TEST_FLOODGATE_KEY, geyser } },
  })
  via(VIAVERSION, 'ViaVersion')
  via(VIABACKWARDS, 'ViaBackwards')
  geyser.floodgate = { version: '2.2.5', build: 141, ...cdn.file('floodgate-spigot') }
  expect(await h.app.setups.compat.refresh()).toBeGreaterThan(0)
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  cdn.close()
})

const desired = async (id: string) => loadRevision(h.db, (await h.server(id)).desiredRevisionId)
const jarsOf = async (id: string) => {
  const { spec } = await h.app.specs.desired(h.db, await h.server(id))
  return (spec.env.BLOCKLY_JARS ?? '').split('\n').filter(Boolean)
}
const running = async (id: string) => {
  await h.until(id, 'running')
  await h.settled(id)
}

/**
 * A plain server as every one made before plain Minecraft let Bedrock in: neither choice made, and
 * on Mojang's own server where `mojang`, as the oldest are.
 */
const madeBefore = async (owner: UserActor, name: string, mojang: boolean) => {
  const { id } = await h.create(owner, { name, from: { kind: 'template', key: 'survival' } })
  await running(id)
  const revision = await desired(id)
  const { otherVersions: _o, bedrock: _b, ...settings } = revision.settings
  await h.db
    .update(schema.serverRevisions)
    .set({ settings, ...(mojang ? { loaderVersion: null } : {}) })
    .where(eq(schema.serverRevisions.serverId, id))
  await h.app.servers.stop(owner, id, randomUUID())
  await h.until(id, 'stopped')
  await h.app.servers.start(owner, id, randomUUID())
  await running(id)
  return id
}

describe.skipIf(!hasDatabase)('a new plain server', () => {
  for (const key of ['survival', 'creative', 'hardcore']) {
    test(`${key} runs on Paper with Bedrock on, and isn’t modded`, async () => {
      const owner = await h.user(`Plain ${key}`)
      const preview = await h.app.queries.setupPreview(owner, { kind: 'template', key })
      expect(preview).toMatchObject({ loader: 'vanilla', bedrock: true, mods: [], modpack: null })
      expect(preview.joins.newer).toBe(true)
      const { id } = await h.create(owner, { name: key, from: { kind: 'template', key } })
      await running(id)
      const revision = await desired(id)
      expect(revision).toMatchObject({ loader: 'vanilla', mods: [], modpack: null })
      expect(runsOnPaper(revision)).toBe(true)
      // The newest release Cubepals offers Paper on, which is the one the preview showed.
      expect(revision.gameVersion).toBe(preview.gameVersion)
      expect(revision.settings).toMatchObject({ bedrock: true, otherVersions: 'on' })
      const jars = await jarsOf(id)
      expect(jars.some((line) => line.includes(FLOODGATE))).toBe(true)
      expect(jars.some((line) => line.includes(VIAVERSION))).toBe(true)
      expect(h.runtime.machine(id)?.spec.env).toMatchObject({
        TYPE: 'PAPER',
        ENFORCE_SECURE_PROFILE: 'FALSE',
      })
      const view = await h.app.queries.get(owner, id)
      expect(view.bedrock).toEqual({ on: true, needsOtherVersions: false, moves: false })
      expect(view.joins?.otherVersions).toBe('on')
    }, 60_000)
  }

  test('one made from nothing lands where Paper runs it too', async () => {
    const owner = await h.user('Nothing')
    const { id } = await h.create(owner, { name: 'Nothing' })
    await running(id)
    const revision = await desired(id)
    expect(runsOnPaper(revision)).toBe(true)
    expect(revision.settings).toMatchObject({ bedrock: true, otherVersions: 'on' })
  }, 60_000)

  test('a plain server asked for on a release without Paper runs Mojang’s own, and says Bedrock can’t join', async () => {
    const owner = await h.user('Newest')
    const { id } = await h.create(owner, {
      name: 'Newest',
      from: { kind: 'template', key: 'survival', gameVersion: '26.3' },
    })
    await running(id)
    expect((await desired(id)).loaderVersion).toBeNull()
    expect((await h.app.queries.get(owner, id)).bedrock).toBeNull()
    expect(await jarsOf(id)).toEqual([])
    const refused = await h.app.revisions.changeBedrock(owner, id, true, randomUUID()).catch((e) => e)
    expect(refused).toBeInstanceOf(AppError)
    expect((refused as AppError).message).toContain('26.3')
  }, 60_000)
})

describe.skipIf(!hasDatabase)('a plain server made before', () => {
  test('on Mojang’s own server, it is left as it was, and one step moves it onto Paper with a backup first', async () => {
    const owner = await h.user('Older')
    const id = await madeBefore(owner, 'Older', true)
    expect(await jarsOf(id)).toEqual([])
    expect(h.runtime.machine(id)?.spec.env.TYPE).toBe('VANILLA')
    expect((await h.app.queries.get(owner, id)).bedrock).toEqual({
      on: false,
      needsOtherVersions: false,
      moves: true,
    })

    const before = (await h.server(id)).desiredRevisionId
    await h.app.revisions.changeBedrock(owner, id, true, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.desiredRevisionId !== before)
    await h.settled(id)
    const revision = await desired(id)
    expect(runsOnPaper(revision)).toBe(true)
    expect(revision.settings).toMatchObject({ bedrock: true, otherVersions: 'on' })
    expect(h.runtime.machine(id)?.spec.env.TYPE).toBe('PAPER')
    expect((await jarsOf(id)).some((line) => line.includes(FLOODGATE))).toBe(true)
    expect((await h.app.queries.get(owner, id)).bedrock).toEqual({
      on: true,
      needsOtherVersions: false,
      moves: false,
    })
    const [backup] = await h.db
      .select({ trigger: schema.backups.trigger, revisionId: schema.backups.revisionId })
      .from(schema.backups)
      .where(and(eq(schema.backups.serverId, id), eq(schema.backups.trigger, 'pre_apply')))
    expect(backup?.revisionId).toBe(before)

    // Stopping them leaves it on Paper; Mojang's own server is its own switch.
    await h.app.revisions.changeBedrock(owner, id, false, randomUUID())
    await running(id)
    expect(runsOnPaper(await desired(id))).toBe(true)
    expect((await jarsOf(id)).some((line) => line.includes(FLOODGATE))).toBe(false)
  }, 120_000)

  test('on Paper, it lets nobody new in until asked, and then it is one switch', async () => {
    const owner = await h.user('Paper Before')
    const id = await madeBefore(owner, 'Paper Before', false)
    expect(runsOnPaper(await desired(id))).toBe(true)
    expect(await jarsOf(id)).toEqual([])
    const view = await h.app.queries.get(owner, id)
    expect(view.bedrock).toEqual({ on: false, needsOtherVersions: false, moves: false })
    expect(view.joins?.otherVersions).toBe('off')

    await h.app.revisions.changeBedrock(owner, id, true, randomUUID())
    await running(id)
    const revision = await desired(id)
    expect(revision.loaderVersion).not.toBeNull()
    expect(revision.settings).toMatchObject({ bedrock: true, otherVersions: 'on' })
    expect((await jarsOf(id)).some((line) => line.includes(FLOODGATE))).toBe(true)
  }, 120_000)
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Changes that only a start places, chosen to wait for everyone to leave: Other versions and
 * Bedrock, whose plugins drift's digest leaves out, and the owner's Stop cheaters switch, which is
 * in no revision. Drift brings each once the last player leaves, as the page says; what Cubepals
 * turned on itself still waits for the next start, and a boot that didn't take a change isn't
 * tried again every pass.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { FakeGeyserMc } from '../../infra/fake/fake-geysermc.ts'
import { VIABACKWARDS, VIAVERSION } from '../../minecraft/mods.ts'
import { GRIM } from '../../minecraft/stop-cheaters.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { catalogPins } from '../../testing/compat-pins.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadApplied } from './restart-wait.ts'

let h: Harness
const cdn = new Cdn()
const geyser = new FakeGeyserMc()
/** A key for tests: 16 bytes as base64, nothing a deployment uses. */
const TEST_FLOODGATE_KEY = Buffer.alloc(16, 9).toString('base64')

/** A plugin on the catalog, under its real project id, for every release Cubepals offers. */
const publish = (projectId: string, name: string) =>
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
  publish(VIAVERSION, 'ViaVersion')
  publish(VIABACKWARDS, 'ViaBackwards')
  publish(GRIM, 'Grim Anticheat')
  geyser.floodgate = { version: '2.2.5', build: 141, ...cdn.file('floodgate-spigot') }
  expect(await h.app.setups.compat.refresh(await catalogPins(h.catalog, geyser.floodgate))).toBeGreaterThan(0)
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  cdn.close()
})

/** A running Smooth server (Paper), which drift has already looked at and found as it should be. */
const running = async (name: string) => {
  const owner = await h.user(name, 'free')
  const { id } = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
  await h.until(id, 'running')
  await h.settled(id)
  expect(await h.app.schedules.drift()).toBe(0)
  return { owner, id }
}

/** Someone on the server, as the presence sync sees them; the returned call has them leave. */
const playing = async (id: string) => {
  const uuid = randomUUID()
  h.minecraft.join(id, { uuid, name: 'Alex' })
  await h.app.schedules.presenceSync()
  return async () => {
    h.minecraft.leave(id, uuid)
    await h.app.schedules.presenceSync()
  }
}

const applies = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'apply')
const waitingOf = async (owner: UserActor, id: string) => (await h.app.queries.get(owner, id)).waiting

/** Drift leaves the change while anyone is on, and brings it once the last player leaves. */
const broughtOnceEmpty = async (id: string, leave: () => Promise<void>) => {
  expect(await h.app.schedules.drift()).toBe(0)
  expect(await applies(id)).toHaveLength(0)
  await leave()
  expect(await h.app.schedules.drift()).toBe(1)
  await h.settled(id)
  expect((await applies(id)).map((op) => op.status)).toEqual(['succeeded'])
}

describe.skipIf(!hasDatabase)('a change only a start places, waiting for everyone to leave', () => {
  test('Other versions waits, and the server takes it once the last player leaves', async () => {
    const { owner, id } = await running('Wren')
    const leave = await playing(id)
    await h.app.revisions.changeOtherVersions(owner, id, 'off', randomUUID(), { when: 'empty' })
    expect((await waitingOf(owner, id))?.changes).toEqual([{ field: 'otherVersions', from: 'on', to: 'off' }])
    await broughtOnceEmpty(id, leave)
    const server = await h.server(id)
    expect((await loadApplied(h.db, id))?.revisionId).toBe(server.desiredRevisionId)
    expect((await loadApplied(h.db, id))?.compat).not.toContain(VIAVERSION)
    expect(await waitingOf(owner, id)).toBeNull()
  }, 60_000)

  test('Bedrock waits by default, and the server takes it once the last player leaves', async () => {
    const { owner, id } = await running('Yarrow')
    expect((await loadApplied(h.db, id))?.compat?.length).toBeGreaterThan(0)
    const leave = await playing(id)
    await h.app.revisions.changeBedrock(owner, id, false, randomUUID())
    expect((await waitingOf(owner, id))?.changes).toEqual([{ field: 'bedrock', from: true, to: false }])
    const before = (await loadApplied(h.db, id))?.compat ?? []
    await broughtOnceEmpty(id, leave)
    expect((await loadApplied(h.db, id))?.compat).not.toEqual(before)
    expect(await waitingOf(owner, id)).toBeNull()
  }, 60_000)

  test('the owner’s Stop cheaters switch waits, and the server boots for it once the last player leaves', async () => {
    const { owner, id } = await running('Zinnia')
    const leave = await playing(id)
    await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'empty')
    expect((await waitingOf(owner, id))?.stopCheaters).toBe('on')
    await broughtOnceEmpty(id, leave)
    expect((await applies(id))[0]?.input).toMatchObject({ boot: true })
    expect((await loadApplied(h.db, id))?.placedStopCheaters).toBe(true)
    expect(await waitingOf(owner, id)).toBeNull()

    // A boot that left it as it was isn't tried again every pass: the page still offers it.
    await h.db
      .update(schema.serverRuntimes)
      .set({ applied: sql`${schema.serverRuntimes.applied} || '{"placedStopCheaters": false}'::jsonb` })
      .where(eq(schema.serverRuntimes.serverId, id))
    expect((await waitingOf(owner, id))?.stopCheaters).toBe('on')
    expect(await h.app.schedules.drift()).toBe(0)
    expect(await applies(id)).toHaveLength(1)
  }, 90_000)

  test('Stop cheaters turned on by publishing still waits for the next start', async () => {
    const { owner, id } = await running('Aster')
    await h.app.listings.setPublic(owner, id, true)
    expect((await waitingOf(owner, id))?.stopCheaters).toBe('on')
    expect(await h.app.schedules.drift()).toBe(0)
    expect(await applies(id)).toHaveLength(0)
  }, 60_000)
})

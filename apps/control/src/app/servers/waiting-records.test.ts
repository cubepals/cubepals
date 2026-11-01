// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Held changes persist their exact operation, audit and event before workers execute. The queue
 * port is held only after the real server boot, so these database contracts do not wait through
 * the player warning. The existing waiting suites execute the full boot and its warning.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { RestartWhen } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { ServerSettings } from '../../domain/revision/revision.ts'
import { GRIM } from '../../minecraft/stop-cheaters.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadStopCheaters, saveStopCheaters } from '../stop-cheaters/persistence.ts'
import { stopCheatersWaiting } from '../stop-cheaters/waiting.ts'
import { loadRevision } from './persistence.ts'
import { loadApplied } from './restart-wait.ts'
import { waitingChanges } from './waiting.ts'

let h: Harness
const cdn = new Cdn()
beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness()
  h.catalog.publish(
    {
      projectId: GRIM,
      slug: 'grimac',
      name: 'Grim Anticheat',
      summary: '',
      iconUrl: null,
      environments: ['server_only'],
      downloads: 1,
    },
    [
      {
        versionId: 'grim-records',
        projectId: GRIM,
        versionLabel: '2.3',
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['paper', 'spigot'],
        gameVersions: offeredVersions().map((v) => v.id),
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file: cdn.file('grim-records'),
        dependencies: [],
      },
    ],
  )
  expect(await h.app.setups.compat.refresh()).toBeGreaterThan(0)
}, 30_000)
afterAll(async () => {
  await h?.close()
  cdn.close()
})

async function running(name: string) {
  const owner = await h.user(name, 'plus')
  const { id } = await h.create(owner, { name, from: { kind: 'template', key: 'smooth' } })
  await h.until(id, 'running', 3_000)
  await h.settled(id, 3_000)
  return { owner, id }
}
async function playing(id: string) {
  h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
  await h.app.schedules.presenceSync()
}
async function occupied(name: string) {
  const result = await running(name)
  await playing(result.id)
  return result
}
const settingsOf = async (id: string) =>
  (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
const change = async (owner: UserActor, id: string, patch: Partial<ServerSettings>, when: RestartWhen) =>
  h.app.revisions.changeSettings(owner, id, { ...(await settingsOf(id)), ...patch }, randomUUID(), { when })
const applies = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'apply')
const waitingOf = async (id: string) =>
  stopCheatersWaiting(h.db, await h.server(id), await loadApplied(h.db, id))

test.skipIf(!hasDatabase)(
  'settling a held change records its exact operation, audit and event before workers run',
  recordedWaiting,
  30_000,
)
test.skipIf(!hasDatabase)(
  'held anticheat switches settle their real records before a boot is executed',
  recordedAnticheat,
  30_000,
)

/** Inspect persisted intent with the queue port held; the existing boot cases execute it. */
async function recordedWaiting() {
  const { owner, id } = await running('Recorded waiting')
  await playing(id)
  const before = await h.server(id)
  const applied = await loadApplied(h.db, id)
  expect(await waitingChanges(h.db, before, applied)).toBeNull()
  expect(await waitingChanges(h.db, before, null)).toBeNull()
  expect(
    await waitingChanges(h.db, { ...before, lifecycle: { ...before.lifecycle, status: 'stopped' } }, applied),
  ).toBeNull()
  await expect(h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())).rejects.toMatchObject({
    code: 'invalid_choice',
    message: 'Nothing is waiting for the server any more.',
  })
  await change(owner, id, { maxPlayers: 4 }, 'empty')
  await h.app.revisions.resize(owner, id, '4g', randomUUID(), { when: 'empty' })
  expect((await h.app.queries.get(owner, id)).waiting).toEqual({
    changes: [{ field: 'maxPlayers', from: 5, to: 4 }],
    size: { from: '3 GB', to: '4 GB' },
    stopCheaters: null,
  })
  const stranger = await h.user('Waiting stranger', 'plus')
  await expect(h.app.stopCheaters.waiting.settle(stranger, id, 'cancel', randomUUID())).rejects.toMatchObject(
    { name: 'NotFound' },
  )
  const queued = spyOn(h.jobs, 'enqueue').mockResolvedValue()
  const published = spyOn(h.events, 'publish')
  try {
    await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
    expect(await h.server(id)).toMatchObject({
      desiredRevisionId: before.desiredRevisionId,
      memoryTier: '3g',
      lifecycle: { status: 'running' },
    })
    expect((await h.app.queries.get(owner, id)).waiting).toBeNull()
    const cancelled = await h.server(id)
    expect(published.mock.calls.map((call) => call[1])).toContainEqual({
      type: 'server_changed',
      serverId: id,
      ownerId: owner.userId,
      status: 'running',
      version: cancelled.version,
    })
    const held = await change(owner, id, { viewDistance: 7 }, 'empty')
    const requestId = randomUUID()
    await h.app.stopCheaters.waiting.settle(owner, id, 'now', requestId)
    const [operation] = await applies(id)
    expect(operation).toMatchObject({
      kind: 'apply',
      status: 'queued',
      requestedBy: `user:${owner.userId}`,
      idempotencyKey: `apply:${requestId}`,
      input: { revisionId: held.desiredRevisionId },
    })
    expect(operation?.input).toEqual({ revisionId: held.desiredRevisionId })
    expect(queued).toHaveBeenCalledTimes(1)
    const current = await h.server(id)
    expect(published.mock.calls.map((call) => call[1])).toContainEqual({
      type: 'server_changed',
      serverId: id,
      ownerId: owner.userId,
      status: current.lifecycle.status,
      version: current.version,
    })
    const rows = await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, id))
    for (const action of ['server.waiting_cancelled', 'server.waiting_applied'])
      expect(rows.find((row) => row.action === action)).toMatchObject({
        actor: `user:${owner.userId}`,
        action,
        subjectType: 'server',
        subjectId: id,
        data: {},
      })
  } finally {
    queued.mockRestore()
    published.mockRestore()
  }
}

/** Inspect persisted intent with the queue port held; the existing boot cases execute it. */
async function recordedAnticheat() {
  const { owner, id } = await occupied('Recorded anticheat')
  await h.app.stopCheaters.set(owner, id, true, randomUUID(), 'empty')
  await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
  expect(await loadStopCheaters(h.db, id)).toMatchObject({ setting: 'off', takeOver: false, reason: null })
  const applied = await loadApplied(h.db, id)
  if (!applied) throw new Error('The fixture must have booted')
  await h.db
    .update(schema.serverRuntimes)
    .set({ applied: { ...applied, placedStopCheaters: true } })
    .where(eq(schema.serverRuntimes.serverId, id))
  await saveStopCheaters(h.db, id, { setting: 'off', reason: 'browse', takeOver: true })
  await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
  expect(await loadStopCheaters(h.db, id)).toMatchObject({ setting: 'on', takeOver: false, reason: null })
  await saveStopCheaters(h.db, id, { setting: 'on', reason: 'browse', takeOver: true })
  expect(await waitingOf(id)).toBe('ours')
  await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
  expect(await loadStopCheaters(h.db, id)).toMatchObject({
    setting: 'on',
    takeOver: false,
    reason: 'browse',
  })
  await saveStopCheaters(h.db, id, { setting: 'off' })
  const queued = spyOn(h.jobs, 'enqueue').mockResolvedValue()
  try {
    await h.app.stopCheaters.waiting.settle(owner, id, 'now', randomUUID())
    const [operation] = await applies(id)
    expect(operation?.input).toEqual({ revisionId: (await h.server(id)).desiredRevisionId, boot: true })
    expect(queued).toHaveBeenCalledTimes(1)
  } finally {
    queued.mockRestore()
  }
}

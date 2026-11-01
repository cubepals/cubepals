// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The Players page distinguishes missing builds, owned settings, incompatible loaders and today's removals. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DAY_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { GRIM } from '../../minecraft/stop-cheaters.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { pluginJar } from '../../testing/uploads.ts'
import { loadRevision } from '../servers/persistence.ts'

let h: Harness
const cdn = new Cdn()
beforeAll(async () => {
  if (!hasDatabase) return
  await cdn.start()
  h = await startHarness()
}, 30 * SECOND_MS)
afterAll(async () => {
  try {
    await h?.close()
  } finally {
    cdn.close()
  }
})

describe.skipIf(!hasDatabase)('Stop cheaters on the Players page', () => {
  test(
    'shows the actual build availability, switch and ownership of the settings',
    async () => {
      const owner = await h.user('Settings owner', 'plus')
      const { id } = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
      await h.until(id, 'running', 3 * SECOND_MS)
      await h.settled(id, 3 * SECOND_MS)
      await h.app.servers.stop(owner, id, crypto.randomUUID())
      await h.until(id, 'stopped', 3 * SECOND_MS)
      await h.settled(id, 3 * SECOND_MS)
      const revisionId = (await h.server(id)).desiredRevisionId
      const revision = await loadRevision(h.db, revisionId)
      expect(await h.app.stopCheaters.viewOf(owner, id)).toEqual({
        effective: false,
        setting: 'auto',
        why: null,
        own: false,
        available: { kind: 'release', release: revision.gameVersion },
        removals: [],
        today: 0,
      })
      await h.db.insert(schema.compatPlugins).values({
        gameVersion: revision.gameVersion,
        projectId: GRIM,
        pinned: cdn.publish('Grim'),
        pinnedAt: new Date(),
      })
      await h.app.stopCheaters.set(owner, id, true, crypto.randomUUID())
      await h.db
        .update(schema.serverRuntimes)
        .set({
          applied: sql`coalesce(${schema.serverRuntimes.applied}, '{}'::jsonb) || '{"stopCheaters":"own"}'::jsonb`,
        })
        .where(eq(schema.serverRuntimes.serverId, id))
      expect(await h.app.stopCheaters.viewOf(owner, id)).toEqual({
        effective: true,
        setting: 'on',
        why: null,
        own: true,
        available: { kind: 'yes' },
        removals: [],
        today: 0,
      })
      await h.app.stopCheaters.set(owner, id, false, crypto.randomUUID())
      await h.db
        .update(schema.serverRevisions)
        .set({ loader: 'fabric' })
        .where(eq(schema.serverRevisions.id, revisionId))
      expect(await h.app.stopCheaters.viewOf(owner, id)).toEqual({
        effective: false,
        setting: 'off',
        why: null,
        own: false,
        available: { kind: 'modded' },
        removals: [],
        today: 0,
      })
      await h.db.delete(schema.serverRuntimes).where(eq(schema.serverRuntimes.serverId, id))
      expect((await h.app.stopCheaters.viewOf(owner, id)).own).toBe(false)
    },
    30 * SECOND_MS,
  )

  test(
    'counts only this UTC day while retaining the exact removal history',
    async () => {
      const owner = await h.user('History owner', 'plus')
      const { id } = await h.create(owner)
      await h.until(id, 'running', 3 * SECOND_MS)
      await h.settled(id, 3 * SECOND_MS)
      const now = new Date('2026-06-10T12:00:00Z')
      const events = [new Date(now.getTime() - DAY_MS), new Date(now.getTime() - SECOND_MS), now].map(
        (at) => ({
          kind: 'removed' as const,
          at: at.toISOString(),
          uuid: crypto.randomUUID(),
          name: 'Player',
          reason: 'speed' as const,
        }),
      )
      await h.app.stopCheaters.recordRemovals(id, events)
      const server = await h.server(id)
      const view = await h.app.stopCheaters.view(
        server,
        await loadRevision(h.db, server.desiredRevisionId),
        now,
      )
      expect(view.today).toBe(2)
      expect(view.removals).toEqual(
        events.toReversed().map((event) => ({
          player: { uuid: event.uuid, name: event.name },
          reason: event.reason,
          at: event.at,
        })),
      )
    },
    30 * SECOND_MS,
  )
})

describe.skipIf(!hasDatabase)('Stop cheaters restart requests', () => {
  test(
    'an occupied server waits, a reversal cancels it, and a restart keeps its request',
    async () => {
      const owner = await h.user('Waiting owner', 'plus')
      const { id } = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
      await h.until(id, 'running', 3 * SECOND_MS)
      await h.settled(id, 3 * SECOND_MS)
      const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
      const pinned = { ...cdn.publish('Grim', Buffer.from(pluginJar('Grim', 21))), loaders: ['paper'] }
      await h.db
        .insert(schema.compatPlugins)
        .values({ gameVersion: revision.gameVersion, projectId: GRIM, pinned, pinnedAt: new Date() })
        .onConflictDoUpdate({
          target: [schema.compatPlugins.gameVersion, schema.compatPlugins.projectId],
          set: { pinned },
        })
      const player = { uuid: crypto.randomUUID(), name: 'Alex' }
      h.minecraft.join(id, player)
      await h.app.schedules.presenceSync()
      const applies = async () => (await h.operations(id)).filter((op) => op.kind === 'apply')
      await h.app.stopCheaters.set(owner, id, true, crypto.randomUUID(), 'empty')
      expect((await h.app.queries.get(owner, id)).waiting?.stopCheaters).toBe('on')
      expect(await applies()).toHaveLength(0)
      await h.app.stopCheaters.set(owner, id, false, crypto.randomUUID(), 'empty')
      expect((await h.app.queries.get(owner, id)).waiting).toBeNull()
      expect(await applies()).toHaveLength(0)
      const requestId = crypto.randomUUID()
      await h.app.stopCheaters.set(owner, id, true, requestId, 'now')
      const [applied] = await applies()
      expect(applied?.input).toEqual({ boot: true })
      const [request] = await h.db
        .select()
        .from(schema.serverOperations)
        .where(eq(schema.serverOperations.id, applied?.id ?? crypto.randomUUID()))
      expect(request).toMatchObject({
        idempotencyKey: `apply:${requestId}`,
        requestedBy: `user:${owner.userId}`,
      })
      await h.settled(id)
      h.minecraft.join(id, player)
      await h.app.schedules.presenceSync()
      await h.app.stopCheaters.useOurs(owner, id, crypto.randomUUID(), 'empty')
      expect((await h.app.queries.get(owner, id)).waiting?.stopCheaters).toBe('ours')
      expect(await applies()).toHaveLength(1)
    },
    30 * SECOND_MS,
  )
})

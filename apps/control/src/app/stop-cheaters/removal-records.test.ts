// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Reporter removals preserve identity and ownership, and a run of removals earns one audited ban. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { LIBERTYBANS, LUCKPERMS } from '../../minecraft/moderation.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadRevision } from '../servers/persistence.ts'
import { installTuning, tuning } from '../tuning.ts'
import { BAN_REASON, STOP_CHEATERS_ACTOR } from './service.ts'

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

async function server() {
  const owner = await h.user('Reporter', 'plus')
  const created = await h.create(owner)
  await h.until(created.id, 'running', 3 * SECOND_MS)
  await h.settled(created.id, 3 * SECOND_MS)
  await h.app.servers.stop(owner, created.id, crypto.randomUUID())
  await h.until(created.id, 'stopped', 3 * SECOND_MS)
  await h.settled(created.id, 3 * SECOND_MS)
  return { owner, id: created.id }
}

describe.skipIf(!hasDatabase)('recorded removal evidence', () => {
  test(
    'keeps normalized history private to its owner and refuses takeover while off',
    async () => {
      const { owner, id } = await server()
      const uuid = crypto.randomUUID()
      const event = {
        kind: 'removed' as const,
        at: new Date().toISOString(),
        uuid: uuid.toUpperCase(),
        name: 'Player',
        reason: 'speed' as const,
      }
      await h.app.stopCheaters.recordRemovals(id, [event])
      const expected = [{ player: { uuid, name: event.name }, reason: event.reason, at: event.at }]
      expect(await h.app.stopCheaters.removalsOf(owner, id, uuid)).toEqual(expected)
      expect((await h.app.stopCheaters.viewOf(owner, id)).removals).toEqual(expected)
      const stranger = await h.user()
      await expect(h.app.stopCheaters.removalsOf(stranger, id, uuid)).rejects.toThrow()
      await expect(h.app.stopCheaters.viewOf(stranger, id)).rejects.toThrow()
      await h.app.stopCheaters.set(owner, id, false, crypto.randomUUID())
      await expect(h.app.stopCheaters.useOurs(owner, id, crypto.randomUUID())).rejects.toMatchObject({
        code: 'invalid_choice',
        message: 'Turn on Stop cheaters first.',
      })
    },
    30 * SECOND_MS,
  )

  test(
    'records the player, configured duration and audit once for an active run of removals',
    async () => {
      const { owner, id } = await server()
      const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
      const mods = [LIBERTYBANS, LUCKPERMS].map((projectId) => {
        const mod = cdn.publish(projectId)
        return { ...mod, source: { ...mod.source, projectId } }
      })
      await h.db
        .update(schema.serverRevisions)
        .set({ mods })
        .where(eq(schema.serverRevisions.id, revision.id))
      const before = tuning()
      const ban = { reason: 'impossible' as const, removals: 3, withinMinutes: 12, minutes: 7 }
      installTuning({ ...before, stopCheaters: { punishments: '', ban } })
      try {
        const uuid = crypto.randomUUID()
        const now = Date.now()
        const events = Array.from({ length: ban.removals + 1 }, (_, offset) => ({
          kind: 'removed' as const,
          at: new Date(now + offset).toISOString(),
          uuid,
          name: 'Player',
          reason: ban.reason,
        }))
        await h.app.stopCheaters.recordRemovals(id, events.slice(0, ban.removals))
        await h.app.stopCheaters.recordRemovals(id, events.slice(ban.removals))
        const actions = await h.db
          .select()
          .from(schema.serverModerationActions)
          .where(eq(schema.serverModerationActions.serverId, id))
        expect(actions).toEqual([
          expect.objectContaining({
            playerUuid: uuid,
            playerName: 'Player',
            kind: 'ban',
            reason: BAN_REASON,
            minutes: ban.minutes,
            requestedBy: STOP_CHEATERS_ACTOR,
          }),
        ])
        const audits = await h.db
          .select()
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'moderation.punished')))
        expect(audits).toEqual([
          expect.objectContaining({
            actor: STOP_CHEATERS_ACTOR,
            subjectType: 'server',
            data: { playerUuid: uuid, kind: 'ban', minutes: ban.minutes },
          }),
        ])
        expect(await h.app.stopCheaters.removalsOf(owner, id, uuid)).toHaveLength(events.length)
      } finally {
        installTuning(before)
      }
    },
    30 * SECOND_MS,
  )
})

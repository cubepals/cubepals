// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Owner changes retain their audit and realtime events; reporter input cannot invent player identities. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { asc, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { requestedBy } from '../actor.ts'
import type { DomainEvent } from '../ports/events.ts'
import { loadStopCheaters } from './persistence.ts'
import { BAN_REASON, STOP_CHEATERS_ACTOR } from './service.ts'

let h: Harness
beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30 * SECOND_MS)
afterAll(async () => {
  await h?.close()
})

async function stoppedWorld() {
  const owner = await h.user('Switch owner', 'plus')
  const { id } = await h.create(owner, { from: { kind: 'template', key: 'smooth' } })
  await h.until(id, 'running', 3 * SECOND_MS)
  await h.settled(id, 3 * SECOND_MS)
  await h.app.servers.stop(owner, id, crypto.randomUUID())
  await h.until(id, 'stopped', 3 * SECOND_MS)
  await h.settled(id, 3 * SECOND_MS)
  return { owner, id }
}

test('automatic moderation retains its public ban explanation and audit identity', () => {
  expect(STOP_CHEATERS_ACTOR).toBe('system:stop-cheaters')
  expect(BAN_REASON).toBe('Sent something the game can’t, again and again.')
})

describe.skipIf(!hasDatabase)('Stop cheaters owner effects', () => {
  test(
    'on, off and takeover keep their own audit entries and notify the server page',
    async () => {
      const { owner, id } = await stoppedWorld()
      const events: DomainEvent[] = []
      const unsubscribe = await h.events.subscribe((event) => {
        if (event.type === 'server_changed' && event.serverId === id) events.push(event)
      })
      const beforeOperations = (await h.operations(id)).length
      try {
        await h.app.stopCheaters.set(owner, id, false, crypto.randomUUID())
        expect(await loadStopCheaters(h.db, id)).toMatchObject({
          setting: 'off',
          reason: null,
          takeOver: false,
        })
        await h.app.stopCheaters.set(owner, id, true, crypto.randomUUID())
        expect(await loadStopCheaters(h.db, id)).toMatchObject({
          setting: 'on',
          reason: null,
          takeOver: false,
        })
        await h.app.stopCheaters.useOurs(owner, id, crypto.randomUUID())
        expect(await loadStopCheaters(h.db, id)).toMatchObject({ setting: 'on', takeOver: true })
        const audit = await h.db
          .select({
            actor: schema.auditLog.actor,
            action: schema.auditLog.action,
            subjectType: schema.auditLog.subjectType,
          })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.subjectId, id))
          .orderBy(asc(schema.auditLog.at))
        expect(audit.filter((row) => row.action.startsWith('moderation.'))).toEqual(
          [
            'moderation.stop_cheaters_off',
            'moderation.stop_cheaters_on',
            'moderation.stop_cheaters_ours',
          ].map((action) => ({ actor: requestedBy(owner), action, subjectType: 'server' })),
        )
        const server = await h.server(id)
        const deadline = Date.now() + SECOND_MS
        while (events.length < 3 && Date.now() < deadline) await Bun.sleep(SECOND_MS / 100)
        expect(events).toEqual(
          Array(3).fill({
            type: 'server_changed',
            serverId: id,
            ownerId: server.ownerId,
            status: server.lifecycle.status,
            version: server.version,
          }),
        )
        expect((await h.operations(id)).length).toBe(beforeOperations)
      } finally {
        await unsubscribe()
      }
    },
    30 * SECOND_MS,
  )

  test(
    'removals without a name use an empty name, and a UUID must match the whole input',
    async () => {
      const { owner, id } = await stoppedWorld()
      const uuid = crypto.randomUUID()
      const at = new Date().toISOString()
      await h.app.stopCheaters.recordRemovals(id, [{ kind: 'removed', at, uuid, reason: 'speed' }])
      expect(await h.app.stopCheaters.removalsOf(owner, id, uuid)).toEqual([
        { player: { uuid, name: '' }, reason: 'speed', at },
      ])
      const invalid = [`a${uuid}`, `${uuid}a`]
      for (const value of invalid)
        await h.app.stopCheaters.recordRemovals(id, [
          { kind: 'removed', at, uuid: value, name: 'Invalid', reason: 'speed' },
        ])
      const rows = await h.db
        .select()
        .from(schema.serverRemovals)
        .where(eq(schema.serverRemovals.serverId, id))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ playerUuid: uuid, playerName: '', reason: 'speed' })
    },
    30 * SECOND_MS,
  )
})

test.skipIf(!hasDatabase)(
  'non-removals and incomplete reporter identities leave no removal records',
  async () => {
    const { ServerJoinEvent } = await import('@blockly/contracts/join-records')
    const { owner, id } = await stoppedWorld()
    const at = new Date().toISOString(),
      uuid = crypto.randomUUID()
    const otherKind = ServerJoinEvent.shape.kind.options.find((kind) => kind !== 'removed')
    if (!otherKind) throw new Error('The reporter must have an event other than removal')
    const events = [
      { kind: otherKind, at, uuid, reason: 'speed' },
      { kind: 'removed', at, uuid, reason: 'unknown-future-reason' },
      { kind: 'removed', at, uuid },
      { kind: 'removed', at, reason: 'speed' },
      { kind: 'removed', at, uuid: 'not-a-player', reason: 'speed' },
    ].map((event) => ServerJoinEvent.parse(event))
    await h.app.stopCheaters.recordRemovals(id, events)
    expect(await h.app.stopCheaters.removalsOf(owner, id, uuid)).toEqual([])
    expect(
      await h.db.select().from(schema.serverRemovals).where(eq(schema.serverRemovals.serverId, id)),
    ).toEqual([])
  },
  30 * SECOND_MS,
)

test.skipIf(!hasDatabase)(
  'a modded server refuses enabling with the complete actionable explanation',
  async () => {
    const { owner, id } = await stoppedWorld()
    await h.db
      .update(schema.serverRevisions)
      .set({ loader: 'fabric' })
      .where(eq(schema.serverRevisions.id, (await h.server(id)).desiredRevisionId))
    await expect(h.app.stopCheaters.set(owner, id, true, crypto.randomUUID())).rejects.toMatchObject({
      code: 'invalid_choice',
      message:
        'Stop cheaters runs on plain Minecraft and Paper servers. Mods change how players move, so it can’t tell a cheat from a mod here.',
    })
  },
  30 * SECOND_MS,
)

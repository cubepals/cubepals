// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An owner's change that waits for everyone to leave a running server: held while someone plays and
 * the owner chose to wait, applied at once otherwise, shown on the server's page, taken now or
 * dropped, and brought by drift once the server is empty.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { RestartWhen } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { ServerSettings } from '../../domain/revision/revision.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision, loadRuntime } from './persistence.ts'

let h: Harness

const running = async (name: string, plan = 'plus') => {
  const owner = await h.user(name, plan)
  const { id } = await h.create(owner, { name })
  await h.until(id, 'running')
  await h.settled(id)
  return { owner, id }
}

const settingsOf = async (id: string) =>
  (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings

const change = async (owner: UserActor, id: string, patch: Partial<ServerSettings>, when?: RestartWhen) =>
  h.app.revisions.changeSettings(owner, id, { ...(await settingsOf(id)), ...patch }, randomUUID(), { when })

const applies = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'apply')

/** Someone on the server, as the presence sync sees them. */
const playing = async (id: string) => {
  const uuid = randomUUID()
  h.minecraft.join(id, { uuid, name: 'Alex' })
  await h.app.schedules.presenceSync()
  return async () => {
    h.minecraft.leave(id, uuid)
    await h.app.schedules.presenceSync()
  }
}

describe.skipIf(!hasDatabase)('a change that waits for everyone to leave', () => {
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })

  test('waits while someone plays and the owner chose to, and shows what waits', async () => {
    const { owner, id } = await running('Holly')
    const leave = await playing(id)
    const before = await h.server(id)
    const from = (await settingsOf(id)).viewDistance
    const moved = await change(owner, id, { viewDistance: 6 }, 'empty')
    expect(moved.lifecycle.status).toBe('running')
    expect(moved.desiredRevisionId).not.toBe(before.desiredRevisionId)
    expect(await applies(id)).toHaveLength(0)
    const view = await h.app.queries.get(owner, id)
    expect(view.waiting).toEqual({
      changes: [{ field: 'viewDistance', from, to: 6 }],
      size: null,
      stopCheaters: null,
    })
    // Drift leaves it while anyone is on, and brings it once they leave.
    expect(await h.app.schedules.drift()).toBe(0)
    await leave()
    expect(await h.app.schedules.drift()).toBe(1)
    await h.settled(id)
    expect((await applies(id)).map((op) => op.status)).toEqual(['succeeded'])
    expect((await loadRuntime(h.db, id, ['fake'])).applied?.revisionId).toBe(moved.desiredRevisionId)
    expect((await h.app.queries.get(owner, id)).waiting).toBeNull()
  }, 60_000)

  test('restarts now when the owner says so, or when nobody is on', async () => {
    const { owner, id } = await running('Ivy')
    const leave = await playing(id)
    await change(owner, id, { viewDistance: 7 }, 'now')
    expect(await applies(id)).toHaveLength(1)
    await h.settled(id)
    await leave()
    // Nobody on: waiting is no reason to hold it.
    await change(owner, id, { viewDistance: 8 }, 'empty')
    expect(await applies(id)).toHaveLength(2)
    await h.settled(id)
    // Left out, a change restarts at once, as it always has.
    await playing(id)
    await change(owner, id, { viewDistance: 9 })
    expect(await applies(id)).toHaveLength(3)
    await h.settled(id)
  }, 60_000)

  test('a setting the game takes as people play never waits', async () => {
    const { owner, id } = await running('Juniper')
    await playing(id)
    await change(owner, id, { difficulty: 'hard' }, 'empty')
    expect(await applies(id)).toHaveLength(1)
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect((await h.app.queries.get(owner, id)).waiting).toBeNull()
  }, 60_000)

  test('dropped, the server keeps what it runs; taken now, it restarts into it', async () => {
    const { owner, id } = await running('Kale')
    await playing(id)
    const runs = (await h.server(id)).desiredRevisionId
    await change(owner, id, { maxPlayers: 3 }, 'empty')
    await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
    expect((await h.server(id)).desiredRevisionId).toBe(runs)
    expect((await h.app.queries.get(owner, id)).waiting).toBeNull()
    expect(await applies(id)).toHaveLength(0)
    const audit = await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, id))
    expect(audit.map((row) => row.action)).toContain('server.waiting_cancelled')
    // Nothing waits any more: neither way out is offered.
    await expect(h.app.stopCheaters.waiting.settle(owner, id, 'now', randomUUID())).rejects.toThrow(
      'Nothing is waiting',
    )

    const held = await change(owner, id, { maxPlayers: 4 }, 'empty')
    await h.app.stopCheaters.waiting.settle(owner, id, 'now', randomUUID())
    const [apply] = await applies(id)
    expect(apply?.input).toEqual({ revisionId: held.desiredRevisionId })
    expect(apply?.requestedBy).toBe(`user:${owner.userId}`)
    await h.settled(id)
    expect((await loadRuntime(h.db, id, ['fake'])).applied?.revisionId).toBe(held.desiredRevisionId)
    const after = await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, id))
    expect(after.map((row) => row.action)).toContain('server.waiting_applied')
  }, 60_000)

  test('a new size waits too, and dropping it keeps the size it runs', async () => {
    const { owner, id } = await running('Laurel')
    await playing(id)
    const before = await h.server(id)
    await h.app.revisions.resize(owner, id, before.memoryTier === '4g' ? '3g' : '4g', randomUUID(), {
      when: 'empty',
    })
    const moved = await h.server(id)
    expect(moved.memoryTier).not.toBe(before.memoryTier)
    expect(await applies(id)).toHaveLength(0)
    expect((await h.app.queries.get(owner, id)).waiting?.size).toEqual({
      from: `${Number.parseInt(before.memoryTier, 10)} GB`,
      to: `${Number.parseInt(moved.memoryTier, 10)} GB`,
    })
    await h.app.stopCheaters.waiting.settle(owner, id, 'cancel', randomUUID())
    expect((await h.server(id)).memoryTier).toBe(before.memoryTier)
  }, 60_000)

  test('someone else’s server: neither way out', async () => {
    const { owner, id } = await running('Myrtle')
    await playing(id)
    await change(owner, id, { viewDistance: 5 }, 'empty')
    const stranger = await h.user('Stranger', 'free')
    await expect(h.app.stopCheaters.waiting.settle(stranger, id, 'cancel', randomUUID())).rejects.toThrow()
    expect((await h.app.queries.get(owner, id)).waiting).not.toBeNull()
  }, 60_000)

  test(
    'settling a held change records its exact operation, audit and event before workers run',
    recordedWaiting,
    30_000,
  )
})

/** Inspect persisted intent with the queue port held; the existing boot cases execute it. */
async function recordedWaiting() {
  const { owner, id } = await running('Recorded waiting')
  await playing(id)
  const before = await h.server(id)
  await change(owner, id, { maxPlayers: 4 }, 'empty')
  await h.app.revisions.resize(owner, id, '4g', randomUUID(), { when: 'empty' })
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

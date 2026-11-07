// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Each finished operation kept once for PostHog (`operations.ts`), against the fake runtime. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { OPERATION_FINISHED } from './operations.ts'

describe.skipIf(!hasDatabase)('operation_finished', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
    h.runtime.sleeps.on = true
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  const kept = async (operationId: string) =>
    (
      await h.db
        .select()
        .from(schema.insightEvents)
        .where(
          and(
            eq(schema.insightEvents.event, OPERATION_FINISHED),
            eq(schema.insightEvents.subject, operationId),
          ),
        )
    ).map((row) => row.properties)

  test('each operation once, with how it ended, how long it took, and whether a start resumed', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.servers.stop(owner, created.id, randomUUID(), 'idle')
    await h.until(created.id, 'stopped')
    await h.settled(created.id)
    await h.app.servers.start(owner, created.id, randomUUID())
    await h.until(created.id, 'running')
    await h.settled(created.id)

    const ops = await h.operations(created.id)
    const provision = ops.find((op) => op.kind === 'provision')
    const stop = ops.find((op) => op.kind === 'stop')
    const start = ops.find((op) => op.kind === 'start')
    expect(await kept(provision?.id ?? '')).toEqual([
      expect.objectContaining({
        kind: 'provision',
        status: 'succeeded',
        way: 'booted',
        server_id: created.id,
      }),
    ])
    expect((await kept(stop?.id ?? ''))[0]).toMatchObject({
      kind: 'stop',
      marks: expect.stringContaining('slept'),
    })
    const [woke] = await kept(start?.id ?? '')
    expect(woke).toMatchObject({ kind: 'start', status: 'succeeded', way: 'resumed', attempts: 1 })
    expect(typeof woke?.seconds).toBe('number')
  }, 60_000)

  test('one that fails for good is kept too, as failed', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    const id = randomUUID()
    await h.db.insert(schema.serverOperations).values({
      id,
      serverId: created.id,
      kind: 'backup',
      status: 'queued',
      requestedBy: 'system:schedule',
      idempotencyKey: `backup:${id}`,
    })
    await h.app.runner.giveUp(id, 'The provider refused it')
    expect(await kept(id)).toEqual([expect.objectContaining({ kind: 'backup', status: 'failed' })])
  }, 60_000)
})

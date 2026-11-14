// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operation that ended while the queue failed its job. An attempt that outlives its deadline is
 * failed by pg-boss, and the runner then records how the operation ended: the operation is
 * settled, and its job stays failed at the head of its server's queue, where every later
 * operation waits behind it. `StuckWork.dropSettled` drops such a job by itself, and leaves one
 * whose operation has not ended for an admin.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { stays, until } from '@blockly/contracts/waits'
import { sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { finishOperation, insertOperation, markRunning } from '../operations/persistence.ts'

describe.skipIf(!hasDatabase)('an operation whose job the queue failed', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  /**
   * A running server with a backup whose job failed at the queue, as one that outlived its
   * deadline on its last attempt does; `ended` says whether the runner had recorded its end.
   */
  async function blocked(ended: boolean) {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const operationId = await h.db.transaction(async (tx) => {
      const { record } = await insertOperation(tx, {
        serverId: id,
        kind: 'backup',
        input: {},
        requestedBy: 'system:test',
        idempotencyKey: `backup:${randomUUID()}`,
      })
      await markRunning(tx, record.id)
      if (ended) await finishOperation(tx, record.id, 'failed', 'It took too long.')
      await h.jobs.enqueue(tx, { operationId: record.id, serverId: id, retryLimit: 0, wakes: false })
      // Failed in the transaction that sends it, so no worker takes it first.
      await tx.execute(
        sql`UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = ${record.id}`,
      )
      return record.id
    })
    return { owner, id, operationId }
  }

  const stopOf = async (id: string) => (await h.operations(id)).find((op) => op.kind === 'stop')

  test('that had ended is dropped by itself, and the stop behind it runs', async () => {
    const { owner, id, operationId } = await blocked(true)
    expect((await h.jobs.blockedOperations()).map((b) => b.operationId)).toContain(operationId)
    await h.app.servers.stop(owner, id, randomUUID())
    await stays(
      'the stop to wait behind the failed job',
      async () => (await stopOf(id))?.status === 'queued',
      1_500,
    )

    expect(await h.app.stuck.dropSettled()).toBe(1)

    await h.until(id, 'stopped')
    expect((await h.jobs.blockedOperations()).map((b) => b.operationId)).not.toContain(operationId)
    const [stop] = (await h.settled(id)).filter((op) => op.kind === 'stop')
    expect(stop?.status).toBe('succeeded')
  }, 60_000)

  test('that has not ended is left for an admin', async () => {
    const { operationId } = await blocked(false)
    expect(await h.app.stuck.dropSettled()).toBe(0)
    await until('the failed job to be listed as blocked', async () =>
      (await h.jobs.blockedOperations()).some((b) => b.operationId === operationId),
    )
  }, 60_000)
})

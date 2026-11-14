// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which line an operation is sent on, as `ServerTransitions.enqueue` decides it, on the harness's
 * real pg-boss: an archive asked to run apart gets a key and a deadline of its own; one not asked
 * to, and any other operation whatever it asks, keeps the server's queue. What the two lines do
 * once sent is `infra/pg/apart-operations.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { ARCHIVE_UPLOAD_SECONDS } from '../ports/optional.ts'
import { findServer } from './persistence.ts'
import { ServerTransitions } from './transitions.ts'

describe.skipIf(!hasDatabase)('the line an operation is sent on', () => {
  let h: Harness
  let id: string

  beforeAll(async () => {
    h = await startHarness()
    const owner = await h.user()
    id = (await h.create(owner)).id
    await h.until(id, 'running')
    await h.settled(id)
  }, 60_000)

  afterAll(async () => {
    await h?.close()
  })

  /** Sends one operation as a service would, and reads its job's key and deadline back. */
  async function sent(kind: 'archive' | 'backup', apart: boolean | undefined) {
    const transitions = new ServerTransitions(h.events, h.jobs)
    const operationId = await h.db.transaction(async (tx) => {
      const server = await findServer(tx, id)
      if (server === null) throw new Error('the server is gone')
      const op = await transitions.enqueue(tx, server, kind, {
        requestedBy: 'system:test',
        idempotencyKey: `${kind}:${randomUUID()}`,
        input: { trigger: 'manual' },
        ...(apart === undefined ? {} : { apart }),
      })
      return op.id
    })
    const { rows } = await h.db.execute(
      sql`SELECT singleton_key AS key, expire_seconds AS deadline FROM pgboss.job WHERE id = ${operationId}`,
    )
    return rows[0] as { key: string; deadline: number }
  }

  test('an archive asked to run apart has a key and a deadline of its own', async () => {
    expect(await sent('archive', true)).toEqual({ key: `${id}:apart`, deadline: ARCHIVE_UPLOAD_SECONDS })
  })

  test('an archive not asked to keeps the server’s queue and an operation’s deadline', async () => {
    const job = await sent('archive', undefined)
    expect(job.key).toBe(id)
    expect(job.deadline).not.toBe(ARCHIVE_UPLOAD_SECONDS)
  })

  test('no other operation runs apart, whatever it asks', async () => {
    expect((await sent('backup', true)).key).toBe(id)
  })
})

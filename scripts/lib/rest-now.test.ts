// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A staging server put to rest now, as the staging check and the join times do it, with the
 * control plane's own store sweep and store against Postgres: work left open after the stop is
 * waited out first, and a store called off because something else waited is asked for again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { SECOND_MS } from '@blockly/contracts/durations'
import { type Harness, hasDatabase, startHarness } from '../../apps/control/src/testing/harness.ts'
import { MemoryStore } from '../../apps/control/src/testing/memory-store.ts'
import { restNow } from './rest-now.ts'

describe.skipIf(!hasDatabase)('a staging server put to rest now', () => {
  let h: Harness
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h?.close()
    store.close()
  })

  /** A server made and stopped by its owner, as each of them leaves one. */
  const stopped = async (name: string) => {
    const owner = await h.user(name)
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    return id
  }

  /** Background work on the server, as the backup or the archive after a stop is: queued, for now. */
  const rows = async (statement: string) =>
    (await h.db.$client.query(statement)).rows as Record<string, unknown>[]
  const queuedWork = async (serverId: string) => {
    const id = randomUUID()
    await rows(
      `insert into server_operations (id, server_id, kind, status, requested_by, idempotency_key)
       values ('${id}', '${serverId}', 'backup', 'queued', 'system:backup', '${randomUUID()}')`,
    )
    return {
      done: () =>
        rows(`update server_operations set status = 'succeeded', finished_at = now() where id = '${id}'`),
    }
  }
  const kinds = async (id: string) =>
    (await h.operations(id)).filter((op) => op.kind === 'store').map((op) => op.status)

  test('waits out the work a stop left open before it asks, so the store is never called off', async () => {
    const id = await stopped('Waits')
    const backup = await queuedWork(id)
    let doneAt = 0
    const asked: number[] = []
    setTimeout(async () => {
      await backup.done()
      doneAt = Date.now()
    }, 3 * SECOND_MS)
    await restNow({
      sql: rows,
      sweep: async () => {
        asked.push(Date.now())
        await h.app.schedules.storeSweep()
      },
      serverId: id,
      idleDays: 40,
      limitMs: 60 * SECOND_MS,
    })
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toBeGreaterThanOrEqual(doneAt)
    expect(await kinds(id)).toEqual(['succeeded'])
  }, 90_000)

  test('asks again when its store is called off because something else waited', async () => {
    const id = await stopped('Twice')
    const notes: string[] = []
    let asks = 0
    await restNow({
      sql: rows,
      sweep: async () => {
        asks++
        await h.app.schedules.storeSweep()
        // Work that arrives just after the ask, as the archive after a stop's backup does: the
        // store finds it waiting and is called off. It is done a moment later.
        if (asks === 1) {
          const archive = await queuedWork(id)
          setTimeout(async () => {
            await archive.done()
          }, 3 * SECOND_MS)
        }
      },
      serverId: id,
      idleDays: 40,
      limitMs: 60 * SECOND_MS,
      note: (line) => notes.push(line),
    })
    expect((await h.server(id)).lifecycle.status).toBe('stored')
    expect(asks).toBe(2)
    expect(notes).toEqual(['not rested (ask 1 of 5): Something else is waiting for it.'])
    expect(await kinds(id)).toEqual(['cancelled', 'succeeded'])
  }, 90_000)
})

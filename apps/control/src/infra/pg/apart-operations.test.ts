// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's work apart, on a real pg-boss: it runs beside the server's queue and in an order of
 * its own, each attempt has the deadline it was sent with, and one that blocks is still found by
 * its server. The two lanes themselves are `server-lanes.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { stays, until } from '@blockly/contracts/waits'
import { createDb, createPool } from '@blockly/db'
import pg from 'pg'
import type { PgBoss } from 'pg-boss'
import type { JobAttempt } from '../../app/ports/jobs.ts'
import { PgBossJobs, startBoss, workServerOperations } from './jobs.ts'

// Needs a real Postgres: DATABASE_URL=postgres://… bun test
const base = process.env.DATABASE_URL
/** What an archive's attempt is sent with; any length other than an operation's own would do. */
const LONG = { deadlineSeconds: 7_200 }

/** A database of its own, so the queues here meet nobody else's. */
async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `blockly_test_${randomBytes(5).toString('hex')}`
  const admin = new pg.Client({ connectionString: base })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(base as string)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new pg.Client({ connectionString: base })
      await cleanup.connect()
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await cleanup.end()
    },
  }
}

/** A promise someone else settles. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

describe.skipIf(!base)('a server’s work apart', () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>
  let boss: PgBoss
  let pool: pg.Pool
  let jobs: PgBossJobs

  beforeEach(async () => {
    database = await freshDatabase()
    boss = await startBoss(database.url, { retryDelaySeconds: 0 })
    pool = createPool(database.url, 4)
    jobs = new PgBossJobs(boss)
  }, 30_000)

  afterEach(async () => {
    await boss?.stop({ graceful: false })
    await pool?.end()
    await database?.drop()
  })

  /** Asks for one operation, in a transaction of its own, as one request does. */
  const ask = (op: { id: string; serverId: string; apart?: boolean; wakes?: boolean }) =>
    createDb(pool).transaction((tx) =>
      jobs.enqueue(tx, {
        operationId: op.id,
        serverId: op.serverId,
        retryLimit: 0,
        wakes: op.wakes ?? false,
        ...(op.apart ? { apart: LONG } : {}),
      }),
    )

  /** Works the queue, noting what begins and holding whatever `held` names until its gate opens. */
  async function work(held: ReadonlyMap<string, Promise<void>>) {
    const began: string[] = []
    const run = async ({ operationId }: JobAttempt) => {
      began.push(operationId)
      await held.get(operationId)
    }
    await workServerOperations(boss, run, { concurrency: 4, wakeConcurrency: 2 }, 0.5)
    return began
  }

  test('a stop and a start asked for while an archive runs begin at once', async () => {
    const serverId = randomUUID()
    const archive = { id: randomUUID(), serverId, apart: true }
    const stop = { id: randomUUID(), serverId }
    const start = { id: randomUUID(), serverId, wakes: true }
    const packing = gate()
    await ask(archive)
    const began = await work(new Map([[archive.id, packing.opened]]))
    await until('the archive to begin', () => began.includes(archive.id))
    await ask(stop)
    await until('the stop to begin beside the archive', () => began.includes(stop.id), {
      seen: () => `began: ${began.join(', ')}`,
    })
    await ask(start)
    await until('the start to begin beside the archive', () => began.includes(start.id), {
      seen: () => `began: ${began.join(', ')}`,
    })
    packing.open()
  }, 30_000)

  test('an archive asked for while the server’s queue is held begins at once', async () => {
    const serverId = randomUUID()
    const stop = { id: randomUUID(), serverId }
    const archive = { id: randomUUID(), serverId, apart: true }
    const stopping = gate()
    await ask(stop)
    const began = await work(new Map([[stop.id, stopping.opened]]))
    await until('the stop to begin', () => began.includes(stop.id))
    await ask(archive)
    await until('the archive to begin beside the stop', () => began.includes(archive.id), {
      seen: () => `began: ${began.join(', ')}`,
    })
    stopping.open()
  }, 30_000)

  test('a server’s second archive waits for its first', async () => {
    const serverId = randomUUID()
    const first = { id: randomUUID(), serverId, apart: true }
    const second = { id: randomUUID(), serverId, apart: true }
    const packing = gate()
    await ask(first)
    await ask(second)
    const began = await work(new Map([[first.id, packing.opened]]))
    await until('the first archive to begin', () => began.includes(first.id))
    await stays('the second archive to wait', () => !began.includes(second.id), 1_000)
    packing.open()
    await until('the second archive to begin', () => began.includes(second.id))
    expect(began).toEqual([first.id, second.id])
  }, 30_000)

  test('each attempt has the deadline it was sent with; an operation keeps its own', async () => {
    const serverId = randomUUID()
    const archive = { id: randomUUID(), serverId, apart: true }
    const stop = { id: randomUUID(), serverId }
    await ask(archive)
    await ask(stop)
    const [apart] = await boss.findJobs('server-ops', { id: archive.id })
    const [queued] = await boss.findJobs('server-ops', { id: stop.id })
    expect(apart?.expireInSeconds).toBe(LONG.deadlineSeconds)
    expect(queued?.expireInSeconds).not.toBe(LONG.deadlineSeconds)
  }, 30_000)

  test('one that fails for good is found by its server, and holds up none of its queue', async () => {
    const serverId = randomUUID()
    const archive = { id: randomUUID(), serverId, apart: true }
    const stop = { id: randomUUID(), serverId }
    await ask(archive)
    const began: string[] = []
    await workServerOperations(
      boss,
      async ({ operationId }: JobAttempt) => {
        began.push(operationId)
        if (operationId === archive.id) throw new Error('the store refused it')
      },
      { concurrency: 4, wakeConcurrency: 2 },
      0.5,
    )
    await until('the archive’s job to be blocked', async () => (await jobs.blockedOperations()).length === 1)
    const [blocked] = await jobs.blockedOperations()
    expect(blocked).toMatchObject({ operationId: archive.id, serverId, apart: true })
    await ask(stop)
    await until('the stop to begin behind nothing', () => began.includes(stop.id), {
      seen: () => `began: ${began.join(', ')}`,
    })
  }, 30_000)
})

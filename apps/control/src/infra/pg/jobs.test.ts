// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A scheduled job sent from outside the control plane, as the staging scripts run a sweep: it
 * reaches the queue's worker through pg-boss itself, and touches no database pg-boss isn't in.
 * And the order a worker takes server operations in across servers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, createPool } from '@blockly/db'
import pg from 'pg'
import type { PgBoss } from 'pg-boss'
import { asLibpq, PgBossJobs, runScheduledNow, startBoss } from './jobs.ts'

// Needs a real Postgres: DATABASE_URL=postgres://… bun test
const base = process.env.DATABASE_URL

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

test('a connection string with an sslmode keeps it as libpq means it; one without is left alone', () => {
  const url = new URL(asLibpq('postgres://u:p@db.example:5432/blockly?sslmode=require'))
  expect(url.searchParams.get('sslmode')).toBe('require')
  expect(url.searchParams.get('uselibpqcompat')).toBe('true')
  expect(asLibpq('postgres://u:p@127.0.0.1:5432/blockly')).toBe('postgres://u:p@127.0.0.1:5432/blockly')
  const pinned = 'postgres://u:p@db.example/blockly?sslmode=require&uselibpqcompat=false'
  expect(new URL(asLibpq(pinned)).searchParams.get('uselibpqcompat')).toBe('false')
})

describe.skipIf(!base)('runScheduledNow', () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>
  let boss: PgBoss

  beforeAll(async () => {
    database = await freshDatabase()
    boss = await startBoss(database.url)
  }, 30_000)

  afterAll(async () => {
    await boss?.stop({ graceful: false })
    await database?.drop()
  })

  test('a worker of the scheduled job gets it at once', async () => {
    await boss.createQueue('store-sweep', { policy: 'singleton', retryLimit: 0 })
    await runScheduledNow(database.url, 'store-sweep')
    const got = new Promise<void>((resolve) => {
      void boss.work('store-sweep', { pollingIntervalSeconds: 0.5 }, async () => resolve())
    })
    await got
    expect(await boss.findJobs('store-sweep')).toHaveLength(1)
  }, 10_000)

  test('a database the control plane never made jobs in is refused, and left as it was', async () => {
    const empty = await freshDatabase()
    try {
      const client = new pg.Client({ connectionString: empty.url })
      await client.connect()
      const schemas = async () =>
        (await client.query('select schema_name from information_schema.schemata order by 1')).rows
      const before = await schemas()
      await expect(runScheduledNow(empty.url, 'purge-sweep')).rejects.toThrow()
      expect(await schemas()).toEqual(before)
      await client.end()
    } finally {
      await empty.drop()
    }
  }, 10_000)
})

describe.skipIf(!base)('the order of server operations across servers', () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>
  let boss: PgBoss
  let pool: ReturnType<typeof createPool>

  beforeAll(async () => {
    database = await freshDatabase()
    boss = await startBoss(database.url)
    pool = createPool(database.url)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
    await boss?.stop({ graceful: false })
    await database?.drop()
  })

  test('a paid wake goes first, in either lane, and a new server’s build last', async () => {
    const jobs = new PgBossJobs(boss)
    const [create, freeWake, plusWake, freeStop] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    // Each in a transaction of its own, so each is asked for after the one before.
    const asked = [
      { operationId: create, wakes: false, creates: true },
      { operationId: freeWake, wakes: true },
      { operationId: plusWake, wakes: true, paid: true },
      { operationId: freeStop, wakes: false },
    ]
    for (const job of asked)
      await createDb(pool).transaction((tx) =>
        jobs.enqueue(tx, { ...job, serverId: randomUUID(), retryLimit: 0 }),
      )
    const take = async (options: { minPriority?: number }) => {
      const taken: string[] = []
      for (const _ of asked) for (const job of await boss.fetch('server-ops', options)) taken.push(job.id)
      return taken
    }
    // The wake lane's floor, as workServerOperations asks: starts and wakes only, the paid one first.
    expect(await take({ minPriority: 1 })).toEqual([plusWake, freeWake])
    expect(await take({})).toEqual([freeStop, create])
  }, 10_000)
})

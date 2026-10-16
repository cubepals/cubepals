// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How often idle job workers ask Postgres for work, on a real pg-boss: told of each job by
 * LISTEN/NOTIFY, they ask only at their backstop, yet take a job the moment it is sent. Where the
 * listener can't be opened they fall back to asking every second or two, and that is said.
 * Each fetch is counted as the driver sends it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { SECOND_MS } from '@blockly/contracts/durations'
import pg from 'pg'
import type { PgBoss } from 'pg-boss'
import { startBoss, workListingEligibility, workServerOperations } from './jobs.ts'

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

/** pg-boss's fetch, of every policy: the one statement that claims a job (`fetchNextJob` in its plans). */
const isFetch = (text: unknown) => typeof text === 'string' && text.includes('FOR UPDATE OF j SKIP LOCKED')

/** Counts the fetches pg-boss's pool sends from now on. */
function countFetches(): { count: () => number; restore: () => void } {
  let fetches = 0
  const query = pg.Pool.prototype.query
  const spy = spyOn(pg.Pool.prototype, 'query').mockImplementation(function (
    this: pg.Pool,
    ...args: Parameters<typeof query>
  ) {
    if (isFetch(args[0])) fetches++
    return query.apply(this, args)
  } as typeof query)
  return { count: () => fetches, restore: () => spy.mockRestore() }
}

/** The workers a worker process runs on its busiest queue and on a background one. */
async function work(boss: PgBoss, taken: string[]): Promise<void> {
  await workServerOperations(
    boss,
    async ({ operationId }) => {
      taken.push(operationId)
    },
    { concurrency: 4, wakeConcurrency: 2 },
  )
  await workListingEligibility(boss, async () => {})
}

describe.skipIf(!base)('idle job workers', () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>
  let boss: PgBoss | undefined

  beforeEach(async () => {
    database = await freshDatabase()
  }, 30_000)

  afterEach(async () => {
    await boss?.stop({ graceful: false })
    boss = undefined
    await database?.drop()
  })

  test('told of each job, they ask only at the backstop, and take one the moment it is sent', async () => {
    boss = await startBoss(database.url, { retryDelaySeconds: 0 })
    const taken: string[] = []
    await work(boss, taken)
    // Each worker's first ask, as it starts, is over within a moment.
    await Bun.sleep(SECOND_MS)
    const fetches = countFetches()
    try {
      await Bun.sleep(5 * SECOND_MS)
      // Asking at their own pace, the three would have asked about a dozen times by now.
      expect(fetches.count()).toBe(0)

      const operationId = randomUUID()
      const sent = Date.now()
      await boss.send(
        'server-ops',
        { operationId, retryLimit: 0 },
        { singletonKey: randomUUID(), priority: 1 },
      )
      while (!taken.includes(operationId) && Date.now() - sent < 10 * SECOND_MS) await Bun.sleep(10)
      expect(taken).toContain(operationId)
      expect(Date.now() - sent).toBeLessThan(SECOND_MS)
    } finally {
      fetches.restore()
    }
  }, 30_000)

  test('a listener that cannot be opened is said, and the workers ask at their own pace', async () => {
    const query = pg.Client.prototype.query
    const refusing = spyOn(pg.Client.prototype, 'query').mockImplementation(function (
      this: pg.Client,
      ...args: Parameters<typeof query>
    ) {
      if (typeof args[0] === 'string' && args[0].startsWith('LISTEN'))
        return Promise.reject(new Error('LISTEN is not supported here'))
      return query.apply(this, args)
    } as typeof query)
    const warned = spyOn(console, 'warn')
    try {
      boss = await startBoss(database.url, { retryDelaySeconds: 0 })
      expect(warned.mock.calls.some((call) => String(call[1]).includes('LISTEN/NOTIFY'))).toBe(true)
    } finally {
      refusing.mockRestore()
      warned.mockRestore()
    }
    await work(boss, [])
    const fetches = countFetches()
    try {
      await Bun.sleep(3 * SECOND_MS)
      expect(fetches.count()).toBeGreaterThanOrEqual(4)
    } finally {
      fetches.restore()
    }
  }, 30_000)
})

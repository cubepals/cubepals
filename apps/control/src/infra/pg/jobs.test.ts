// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A scheduled job asked for from outside the control plane, as the staging scripts run a sweep: a
 * worker takes it with its next claim, and no database the control plane didn't make is touched.
 * And the order a worker takes server operations in across servers.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { HOUR_S, SECOND_MS } from '@blockly/contracts/durations'
import { createDb, createPool, schema } from '@blockly/db'
import { eq, getTableName, sql } from 'drizzle-orm'
import pg from 'pg'
import { type PgBoss, states } from 'pg-boss'
import { JobRecord } from '../../app/platform/job-record.ts'
import type { Schedule, ScheduledJob } from '../../app/ports/jobs.ts'
import { Cdn } from '../../testing/cdn.ts'
import { freshDatabase as migratedDatabase } from '../../testing/fleet.ts'
import { CRON } from './cron.ts'
import {
  asLibpq,
  PgBossJobs,
  runScheduledNow,
  startBoss,
  workArtifactMirror,
  workCuration,
  workJarChecks,
  workListingEligibility,
  workSchedules,
  workServerOperations,
  workWorldDownloads,
  workWorldImports,
} from './jobs.ts'

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
  let database: Awaited<ReturnType<typeof migratedDatabase>>

  beforeAll(async () => {
    database = await migratedDatabase()
  }, 30_000)

  afterAll(async () => {
    await database?.drop()
  })

  test(
    'legacy operations preserve retries, sanitize errors and unblock their following work',
    legacyOperations,
    30_000,
  )
  test('scheduled passes record real outcomes and remove their legacy queues', scheduledPasses, 30_000)
  test('curation retries real database failures through the terminal notification', curationRetries, 30_000)
  test('background queues retain actual payloads and terminal download failures', backgroundQueues, 30_000)
  test('a missing schedule is refused before a ticker starts', missingSchedule, 15_000)
  test(
    'a database outage while starting schedules remains visible and stoppable',
    unavailableSchedules,
    15_000,
  )
  test('the next claim of a worker takes the job once, out of its schedule', async () => {
    const record = new JobRecord({ db: database.db })
    await record.scheduled([{ job: 'store-sweep', everySeconds: HOUR_S }], new Date())
    await runScheduledNow(database.url, 'store-sweep')
    // Nothing is due this minute, and the request is taken all the same, once.
    expect(await record.claim([], 300, true)).toEqual(['store-sweep'])
    expect(await record.claim([], 300, true)).toEqual([])
  }, 10_000)

  test('a job the control plane does not schedule is refused', async () => {
    await expect(runScheduledNow(database.url, 'purge-sweep')).rejects.toThrow('not a scheduled job')
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
  test('an API registers compatibility work without starting it', () => registeredChecks(false), 15_000)
  test(
    'the ordinary jar worker starts its registered compatibility importer',
    () => registeredChecks(true),
    15_000,
  )

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

async function registeredChecks(register: boolean) {
  const database = await freshDatabase()
  const boss = await startBoss(database.url)
  const pool = createPool(database.url)
  const db = createDb(pool)
  const jobs = new PgBossJobs(boss)
  const work = spyOn(boss, 'work')
  const seen: string[] = []
  const key = randomUUID()
  try {
    if (register)
      jobs.registerModValidation({
        runImport: async (value) => {
          seen.push(value)
        },
        importGaveUp: async () => {
          throw new Error('This successful check must not give up')
        },
      })
    expect(work).not.toHaveBeenCalled()
    await db.transaction((tx) => jobs.enqueueModValidation(tx, key))
    const queued = await pool.query<{ name: string; state: string }>(
      "SELECT name, state FROM pgboss.job WHERE data->>'importId' = $1",
      [key],
    )
    expect(queued.rows[0]?.state).toBe(states.created)
    const packKey = randomUUID()
    await db.transaction((tx) => jobs.enqueuePackImport(tx, packKey))
    const packJob = await pool.query<{ name: string }>(
      "SELECT name FROM pgboss.job WHERE data->>'importId' = $1",
      [packKey],
    )
    const queue = await boss.getQueue(queued.rows[0]?.name as string)
    const packQueue = await boss.getQueue(packJob.rows[0]?.name as string)
    for (const field of ['policy', 'retryLimit', 'retryDelay', 'expireInSeconds'] as const)
      expect(queue?.[field]).toBe(packQueue?.[field])
    const rolledBack = randomUUID()
    const interrupted = new Error('The owning transaction was rolled back')
    await expect(
      db.transaction(async (tx) => {
        await jobs.enqueueModValidation(tx, rolledBack)
        throw interrupted
      }),
    ).rejects.toBe(interrupted)
    expect(
      (await pool.query("SELECT id FROM pgboss.job WHERE data->>'importId' = $1", [rolledBack])).rows,
    ).toEqual([])
    await workJarChecks(boss, async () => {})
    if (register) {
      const deadline = Date.now() + 5 * SECOND_MS
      while (Date.now() < deadline && seen.length === 0) await Bun.sleep(10)
      expect(seen).toEqual([key])
      expect(work.mock.calls.some((call) => call[0] === queued.rows[0]?.name)).toBe(true)
    } else {
      expect(work.mock.calls.some((call) => call[0] === queued.rows[0]?.name)).toBe(false)
      expect(seen).toEqual([])
    }
  } finally {
    work.mockRestore()
    await boss.stop({ graceful: false })
    await pool.end()
    await database.drop()
  }
}

type QueueFixture = {
  boss: PgBoss
  db: ReturnType<typeof createDb>
  pool: ReturnType<typeof createPool>
  jobs: PgBossJobs
}
async function withQueue(run: (fixture: QueueFixture) => Promise<void>, migrated = false, maintains = true) {
  const database = migrated ? await migratedDatabase() : await freshDatabase()
  const boss = await startBoss(database.url, { retryDelaySeconds: 0, maintains })
  const pool = createPool(database.url)
  try {
    await run({ boss, pool, db: createDb(pool), jobs: new PgBossJobs(boss) })
  } finally {
    await boss.stop({ graceful: false })
    await pool.end()
    await database.drop()
  }
}

async function reaches(done: () => Promise<boolean>) {
  const deadline = Date.now() + 10 * SECOND_MS
  while (Date.now() < deadline) {
    if (await done()) return
    await Bun.sleep(20)
  }
  throw new Error('The real worker did not reach its expected state')
}

async function legacyOperations() {
  await withQueue(async (f) => {
    const serverId = randomUUID(),
      first = randomUUID(),
      discarded = randomUUID(),
      following = randomUUID()
    const allowed = new Set<string>()
    const seen: Array<{ operationId: string; retryLimit: number }> = []
    const enqueue = (operationId: string) =>
      f.db.transaction((tx) => f.jobs.enqueue(tx, { operationId, serverId, retryLimit: 0, wakes: false }))
    await enqueue(first)
    const [queued] = (
      await f.pool.query<{ name: string }>('SELECT name FROM pgboss.job WHERE id = $1', [first])
    ).rows
    if (queued === undefined) throw new Error('The real queue did not retain the operation')
    const { name } = queued
    await f.pool.query("UPDATE pgboss.job SET data = data - 'retryLimit' WHERE id = $1", [first])
    await workServerOperations(
      f.boss,
      async (attempt) => {
        seen.push(attempt)
        if (!allowed.has(attempt.operationId)) throw new Error('provider\u0000disconnected')
      },
      { concurrency: 1, wakeConcurrency: 1 },
    )
    const state = async (id: string) => (await f.boss.findJobs(name, { id }))[0]?.state
    await reaches(async () => (await state(first)) === states.failed)
    expect(seen[0]).toMatchObject({ operationId: first, retryLimit: 0 })
    const blocked = await f.jobs.blockedOperations()
    expect(blocked.map((item) => item.operationId)).toEqual([first])
    expect(blocked[0]?.error).toContain('providerdisconnected')
    expect(blocked[0]?.error).not.toContain('\u0000')
    allowed.add(first)
    await f.jobs.retryBlocked(first)
    await reaches(async () => (await state(first)) === states.completed)
    await enqueue(discarded)
    allowed.add(following)
    await enqueue(following)
    await reaches(async () => (await state(discarded)) === states.failed)
    expect(seen.some((item) => item.operationId === following)).toBe(false)
    await f.jobs.discardBlocked(discarded)
    await reaches(async () => (await state(following)) === states.completed)
    expect(await f.jobs.blockedOperations()).toEqual([])
    for (const failure of ['non-error refusal', { message: 'nested refusal' }, 0]) {
      const id = randomUUID()
      const actualRun = spyOn(allowed, 'has').mockImplementation(() => {
        throw failure
      })
      try {
        await enqueue(id)
        await reaches(async () => (await state(id)) === states.failed)
        const [blocked] = await f.jobs.blockedOperations()
        expect(blocked?.operationId).toBe(id)
        expect(blocked?.error).toBe(
          typeof failure === 'string' ? failure : typeof failure === 'object' ? failure.message : null,
        )
        await f.jobs.discardBlocked(id)
      } finally {
        actualRun.mockRestore()
      }
    }
  })
}

function passFixtures(): Schedule[] {
  return Object.keys(CRON)
    .filter((job): job is ScheduledJob => job !== 'worker-heartbeat')
    .map((job) => ({ job, run: async () => {} }))
}

async function scheduledPasses() {
  await withQueue(async (f) => {
    const record = new JobRecord({ db: f.db, successesTogetherMs: 0 })
    const passes = passFixtures()
    const [counted, quiet, broken, rejected] = passes
    if (!counted || !quiet || !broken || !rejected)
      throw new Error('The production schedules must include four passes')
    let count = 0
    Object.assign(counted, {
      run: async () => {
        count++
        return 1
      },
      says: (n: number) => `${n} handled`,
    })
    Object.assign(quiet, { run: async () => 0, says: (n: number) => `${n} handled` })
    const databaseError = await f.pool.query('SELECT 1 / 0').catch((error) => error)
    broken.run = async () => {
      throw databaseError
    }
    rejected.run = () => Promise.reject('a stream ended without an Error')
    await f.boss.createQueue(counted.job)
    await f.boss.schedule(counted.job, CRON[counted.job])
    const logger = spyOn(console, 'error').mockImplementation(() => {})
    let running: Awaited<ReturnType<typeof workSchedules>> | undefined
    try {
      running = await workSchedules(f.boss, passes, record)
      await reaches(async () => (await record.lastSucceeded()).size === Object.keys(CRON).length - 2)
      expect(await f.boss.getQueue(counted.job)).toBeFalsy()
      const failures = await f.db.select().from(schema.jobHealth).where(eq(schema.jobHealth.job, broken.job))
      expect(failures[0]?.lastError).toBe(databaseError.message)
      expect(logger.mock.calls.length).toBeGreaterThanOrEqual(2)
      await running.runNow([counted.job])
      await reaches(async () => count === 2)
    } finally {
      await running?.stop()
      logger.mockRestore()
    }
  }, true)
}

async function missingSchedule() {
  await withQueue(async (f) => {
    await expect(workSchedules(f.boss, [], new JobRecord({ db: f.db }))).rejects.toThrow(
      'Nothing runs the scheduled job',
    )
  }, true)
}

async function unavailableSchedules() {
  await withQueue(async (f) => {
    const hidden = sql.identifier('unavailable_schedule_health')
    const logger = spyOn(console, 'error').mockImplementation(() => {})
    await f.db.execute(sql`ALTER TABLE ${schema.jobHealth} RENAME TO ${hidden}`)
    let running: Awaited<ReturnType<typeof workSchedules>> | undefined
    try {
      running = await workSchedules(f.boss, passFixtures(), new JobRecord({ db: f.db }))
      expect(logger.mock.calls.length).toBeGreaterThanOrEqual(3)
    } finally {
      await running?.stop()
      await f.db.execute(
        sql`ALTER TABLE ${hidden} RENAME TO ${sql.identifier(getTableName(schema.jobHealth))}`,
      )
      logger.mockRestore()
    }
  }, true)
}

async function curationRetries() {
  await withQueue(
    async (f) => {
      const release = { key: 'queued-curation', version: '1.0' }
      await f.jobs.enqueueCuration(release)
      const [job] = (
        await f.pool.query<{ id: string; name: string }>('SELECT id, name FROM pgboss.job WHERE state = $1', [
          states.created,
        ])
      ).rows
      if (job === undefined) throw new Error('The real queue did not retain the release')
      const queue = await f.boss.getQueue(job.name)
      if (queue === null) throw new Error('The release queue is missing')
      await f.boss.cancel(job.name, job.id)
      await f.boss.updateQueue(job.name, { retryDelay: 0, retryBackoff: false })
      let attempts = 0
      const failures: unknown[][] = []
      await workCuration(f.boss, {
        run: async (actual) => {
          expect(actual).toEqual(release)
          attempts++
          await f.pool.query('SELECT 1/0')
        },
        gaveUp: async (...args) => {
          failures.push(args)
        },
      })
      await f.db.transaction((tx) => f.jobs.enqueueCuration(release, tx))
      const expected = await f.pool.query('SELECT 1/0').catch((error: unknown) => error)
      await reaches(async () => failures.length === 1)
      expect(attempts).toBe((queue.retryLimit ?? 0) + 1)
      expect(failures).toEqual([[release, (expected as Error).message]])
    },
    false,
    false,
  )
}

async function backgroundQueues() {
  await withQueue(
    async (f) => {
      const artifact = new Cdn().publish('queued-mirror').artifact
      const eligible = [randomUUID(), randomUUID()]
      const mirrored: unknown[] = [],
        listed: unknown[] = [],
        checked: string[] = [],
        failures: unknown[][] = []
      await workArtifactMirror(f.boss, async (actual) => {
        mirrored.push(actual)
      })
      await workListingEligibility(f.boss, async (actual) => {
        listed.push(actual)
      })
      await workJarChecks(f.boss, async (actual) => {
        checked.push(actual)
      })
      await f.jobs.enqueueEligibility([])
      await f.jobs.enqueueEligibility([...eligible, ...eligible])
      await f.db.transaction(async (tx) => {
        await f.jobs.enqueueMirror(tx, artifact)
        await f.jobs.enqueueJarCheck(tx, artifact.sha512)
        await f.jobs.enqueueEligibility(eligible, tx)
      })
      await reaches(async () => mirrored.length === 1 && listed.length === 2 && checked.length === 1)
      expect(mirrored).toEqual([artifact])
      expect(listed).toEqual([eligible, eligible])
      expect(checked).toEqual([artifact.sha512])
      for (const download of [true, false]) {
        const probe = randomUUID(),
          id = randomUUID()
        const enqueue = (key: string) =>
          f.db.transaction((tx) =>
            download ? f.jobs.enqueueWorldDownload(tx, key) : f.jobs.enqueueWorldImport(tx, key),
          )
        await enqueue(probe)
        const [job] = (
          await f.pool.query<{ id: string; name: string }>(
            'SELECT id, name FROM pgboss.job WHERE data::text LIKE $1',
            [`%${probe}%`],
          )
        ).rows
        if (job === undefined) throw new Error('The queue did not retain the actual payload')
        await f.boss.cancel(job.name, job.id)
        await f.boss.updateQueue(job.name, { retryDelay: 0, retryBackoff: false })
        const run = async () => {
          throw 'background unavailable'
        }
        const gaveUp = async (...args: unknown[]) => {
          failures.push(args)
        }
        if (download) await workWorldDownloads(f.boss, { make: run, gaveUp })
        else await workWorldImports(f.boss, { runImport: run, importGaveUp: gaveUp })
        await enqueue(id)
        await reaches(async () => failures.some(([key]) => key === id))
        expect(failures.filter(([key]) => key === id)).toEqual([[id, 'background unavailable']])
      }
    },
    false,
    false,
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server operations queue's two lanes, on a real pg-boss: starts and wakes begin at once
 * however many new servers are being made, and never before what their own server queued first.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, createPool } from '@blockly/db'
import pg from 'pg'
import type { PgBoss } from 'pg-boss'
import type { JobAttempt } from '../../app/ports/jobs.ts'
import type { RuntimeHandle, RuntimeKey, RuntimeSpec } from '../../app/ports/runtime.ts'
import { flyClient } from '../fly/client.ts'
import { FakeFly } from '../fly/fake-fly.ts'
import { FlyRuntime } from '../fly/fly-runtime.ts'
import { PgBossJobs, startBoss, workServerOperations } from './jobs.ts'

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

/** A promise someone else settles. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

describe.skipIf(!base)('server operation lanes', () => {
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

  /** Queues operations in one transaction, as a burst of requests would leave them. */
  const enqueue = (ops: ReadonlyArray<{ id: string; serverId: string; wakes: boolean }>) =>
    createDb(pool).transaction(async (tx) => {
      for (const op of ops)
        await jobs.enqueue(tx, { operationId: op.id, serverId: op.serverId, retryLimit: 0, wakes: op.wakes })
    })

  const ops = (count: number, wakes: boolean) =>
    Array.from({ length: count }, () => ({ id: randomUUID(), serverId: randomUUID(), wakes }))

  test('with every main slot held by creates, a wake still begins at once', async () => {
    const creates = ops(50, false)
    const wakes = ops(5, true)
    const isWake = new Set<string>(wakes.map((w) => w.id))
    const held = gate()
    const began: string[] = []
    const finished: string[] = []
    const run = async ({ operationId }: JobAttempt) => {
      began.push(operationId)
      if (!isWake.has(operationId)) await held.opened
      finished.push(operationId)
    }
    await enqueue(creates)
    await workServerOperations(boss, run, { concurrency: 4, wakeConcurrency: 2 }, 0.5)
    await until(() => began.length === 4)

    const asked = Date.now()
    await enqueue(wakes)
    await until(() => wakes.every((w) => finished.includes(w.id)))
    // Every wake ran while all four creates still held their slots, and no other create got one.
    expect(Date.now() - asked).toBeLessThan(2000)
    expect(began.filter((id) => !isWake.has(id))).toHaveLength(4)
    expect(finished.filter((id) => !isWake.has(id))).toEqual([])
    held.open()
    await until(() => finished.length === creates.length + wakes.length, 15_000)
  }, 30_000)

  test('50 creates and 5 wakes queued together: the wakes go first', async () => {
    const creates = ops(50, false)
    const wakes = ops(5, true)
    const isWake = new Set<string>(wakes.map((w) => w.id))
    const began: string[] = []
    const run = async ({ operationId }: JobAttempt) => {
      began.push(operationId)
      await Bun.sleep(isWake.has(operationId) ? 0 : 200)
    }
    // Asked for after every create, in the same moment.
    await enqueue([...creates, ...wakes])
    await workServerOperations(boss, run, { concurrency: 8, wakeConcurrency: 2 }, 0.5)
    await until(() => began.length === creates.length + wakes.length, 15_000)
    // Fetches race, so a create can begin while a wake is being taken; none begins after a whole
    // round of the main lane's slots.
    const lastWake = Math.max(...wakes.map((w) => began.indexOf(w.id)))
    expect(lastWake).toBeLessThan(8 + 2)
  }, 30_000)

  test('a start never passes what its own server queued first', async () => {
    const serverId = randomUUID()
    const backup = { id: randomUUID(), serverId, wakes: false }
    const start = { id: randomUUID(), serverId, wakes: true }
    const held = gate()
    const began: string[] = []
    const run = async ({ operationId }: JobAttempt) => {
      began.push(operationId)
      if (operationId === backup.id) await held.opened
    }
    // Asked for one after the other, as two requests are: one transaction's jobs share a moment.
    await enqueue([backup])
    await enqueue([start])
    await workServerOperations(boss, run, { concurrency: 4, wakeConcurrency: 2 }, 0.5)
    await until(() => began.includes(backup.id))
    await Bun.sleep(500)
    expect(began).toEqual([backup.id])
    held.open()
    await until(() => began.includes(start.id))
    expect(began).toEqual([backup.id, start.id])
  }, 30_000)
})

describe.skipIf(!base)('a server operation refused for now', () => {
  test('is tried again after a pause, not failed', async () => {
    const database = await freshDatabase()
    const boss = await startBoss(database.url, { retryDelaySeconds: 1 })
    const pool = createPool(database.url, 2)
    try {
      const attempts: Array<{ retryCount: number; at: number }> = []
      const run = async ({ retryCount }: JobAttempt) => {
        attempts.push({ retryCount, at: Date.now() })
        if (retryCount === 0) throw new Error('Fly: creating the app failed with 429')
      }
      const op = { operationId: randomUUID(), serverId: randomUUID(), retryLimit: 2, wakes: false }
      await createDb(pool).transaction((tx) => new PgBossJobs(boss).enqueue(tx, op))
      await workServerOperations(boss, run, { concurrency: 1, wakeConcurrency: 1 }, 0.5)
      await until(() => attempts.length === 2, 10_000)
      const [first, second] = attempts
      expect(second?.retryCount).toBe(1)
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(900)
      await Bun.sleep(200)
      const [job] = await boss.findJobs('server-ops', { id: op.operationId })
      expect(job?.state).toBe('completed')
    } finally {
      await boss.stop({ graceful: false })
      await pool.end()
      await database.drop()
    }
  }, 30_000)
})

const spec: RuntimeSpec = {
  image: 'itzg/minecraft-server:2026.9.1-java25',
  env: { EULA: 'TRUE' },
  secrets: {},
  resources: { memoryMb: 2048 },
  storage: { mountPath: '/data', sizeGb: 5 },
  ports: [{ name: 'game', port: 25565, protocol: 'tcp', audience: ['edge'] }],
  stop: { signal: 'SIGTERM', timeoutSeconds: 90 },
  labels: {},
}

describe.skipIf(!base)('server operation lanes on Fly', () => {
  let database: Awaited<ReturnType<typeof freshDatabase>>
  let boss: PgBoss
  let pool: pg.Pool

  beforeEach(async () => {
    database = await freshDatabase()
    boss = await startBoss(database.url, { retryDelaySeconds: 0 })
    pool = createPool(database.url, 4)
  }, 30_000)

  afterEach(async () => {
    await boss?.stop({ graceful: false })
    await pool?.end()
    await database?.drop()
  })

  test('50 creates and 5 wakes queued together on the fake Fly: every wake is up before the creates', async () => {
    const fake = new FakeFly()
    // New apps go out as Fly paces them, every server's from one bucket; a start is its own app's.
    const runtime = new FlyRuntime({
      client: flyClient('token', { fetch: fake.fetch as never, pace: { perSecond: 20, burst: 3 } }),
      org: 'blockly',
      deploymentId: 'test',
      regionMap: { 'eu-central': 'fra' },
      snapshotRetentionDays: 1,
      machineLimit: 1000,
      platformMachines: 0,
    })
    const placement = { regionKey: 'eu-central' }
    const progress = { step: async () => {}, handle: async () => {} }
    const sleeping = new Map<string, RuntimeHandle>()
    for (let i = 0; i < 5; i++) {
      const handle = await runtime.ensureProvisioned(randomUUID() as RuntimeKey, placement, spec, progress)
      await runtime.stop(handle)
      sleeping.set(randomUUID(), handle)
    }

    const operations = new Map<string, { serverId: string; work: () => Promise<unknown> }>()
    for (let i = 0; i < 50; i++) {
      const key = randomUUID() as RuntimeKey
      operations.set(randomUUID(), {
        serverId: key,
        work: () => runtime.ensureProvisioned(key, placement, spec, progress),
      })
    }
    const wakes = [...sleeping].map(([id, handle]) => {
      operations.set(id, { serverId: handle, work: () => runtime.start(handle) })
      return id
    })
    const finished: string[] = []
    const run = async ({ operationId }: JobAttempt) => {
      await operations.get(operationId)?.work()
      finished.push(operationId)
    }
    const jobs = new PgBossJobs(boss)
    await createDb(pool).transaction(async (tx) => {
      for (const [id, op] of operations)
        await jobs.enqueue(tx, {
          operationId: id,
          serverId: op.serverId,
          retryLimit: 0,
          wakes: wakes.includes(id),
        })
    })
    const asked = Date.now()
    await workServerOperations(boss, run, { concurrency: 8, wakeConcurrency: 2 }, 0.5)
    await until(() => wakes.every((id) => finished.includes(id)), 10_000)
    const woken = Date.now() - asked
    await until(() => finished.length === operations.size, 60_000)
    const lastWake = Math.max(...wakes.map((id) => finished.indexOf(id)))
    // Each wake is a few calls to its own app; the creates queue behind Fly's pace for new apps.
    expect(woken).toBeLessThan(3000)
    expect(lastWake).toBeLessThan(10)
    for (const handle of sleeping.values()) expect((await runtime.observe(handle)).state).toBe('running')
  }, 90_000)
})

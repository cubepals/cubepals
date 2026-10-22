// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The database as this process sees it: each pool's connections (in use, idle, the most it may
 * hold, and requests waiting for one), and how long each query on the query pool took and, if it
 * failed, the class of its SQLSTATE. Names and labels are OpenTelemetry's database conventions
 * (`db.client.*`); a query is known by the statement it opens with, never by its text.
 *
 * Not for what Postgres itself says of its load (`postgres.ts`), or for pg-boss's own timings,
 * which pg-boss reports itself.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { metrics } from '@opentelemetry/api'
import type { Pool, PoolClient } from 'pg'
import type { PgBoss } from 'pg-boss'

/** Seconds: the boundaries OpenTelemetry's database conventions advise for a query's duration. */
const QUERY_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]

/** The statements a query is known by. Any other is `_OTHER`, so no query's text becomes a label. */
const OPERATIONS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'SET',
  'SHOW',
  'LOCK',
  'NOTIFY',
  'LISTEN',
  'UNLISTEN',
  'TRUNCATE',
])

/** A pool's counts at one moment, as node-postgres keeps them and pg-boss hands them on. */
interface Counts {
  max: number
  total: number
  idle: number
  waiting: number
}

type Query = (...args: unknown[]) => unknown

const operationOf = (text: unknown): string => {
  const word = typeof text === 'string' ? /^\s*([a-z]+)/i.exec(text)?.[1]?.toUpperCase() : undefined
  return word !== undefined && OPERATIONS.has(word) ? word : '_OTHER'
}

/** The class of a failure's SQLSTATE, its first two characters; `_OTHER` for one with none, such as a dropped connection. */
const errorClassOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code.slice(0, 2) : '_OTHER'
}

/**
 * Times every query `client` runs, by both of node-postgres's forms: with a callback, as the
 * pool's own `query` calls it, and as a promise, as a transaction's queries are. A cursor or
 * stream runs as it is read, and is left untimed.
 */
function timeQueries(client: PoolClient, done: (operation: string, error: unknown, began: number) => void) {
  const query = client.query.bind(client) as Query
  client.query = ((...args: unknown[]) => {
    const [first] = args
    if (typeof (first as { submit?: unknown } | null)?.submit === 'function') return query(...args)
    const operation = operationOf(
      typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text,
    )
    const began = performance.now()
    const callback = args.at(-1)
    if (typeof callback === 'function')
      return query(...args.slice(0, -1), (error: unknown, result: unknown) => {
        done(operation, error, began)
        callback(error, result)
      })
    const running = query(...args) as Promise<unknown>
    running.then(
      () => done(operation, null, began),
      (error: unknown) => done(operation, error, began),
    )
    return running
  }) as PoolClient['query']
}

/**
 * Registers the pools' gauges and times the query pool's queries. Call before the pool opens its
 * first connection: one opened before is never timed.
 */
export function measurePools(role: string, queries: Pool, boss: PgBoss): void {
  const meter = metrics.getMeter('cubepals')
  const duration = meter.createHistogram('db.client.operation.duration', {
    description:
      'How long a query took, by the statement it opens with and, if it failed, its SQLSTATE class',
    unit: 's',
    advice: { explicitBucketBoundaries: QUERY_BUCKETS },
  })
  const pool = { 'db.system.name': 'postgresql', 'db.client.connection.pool.name': 'queries', role }
  queries.on('connect', (client) =>
    timeQueries(client, (operation, error, began) =>
      duration.record((performance.now() - began) / SECOND_MS, {
        ...pool,
        'db.operation.name': operation,
        ...(error ? { 'error.type': errorClassOf(error) } : {}),
      }),
    ),
  )

  const counts: Record<string, () => Counts | null> = {
    queries: () => ({
      max: queries.options.max ?? 10,
      total: queries.totalCount,
      idle: queries.idleCount,
      waiting: queries.waitingCount,
    }),
    jobs: () => boss.getDb().poolCounts?.() ?? null,
  }
  const connections = meter.createObservableUpDownCounter('db.client.connection.count', {
    description: 'Connections a pool holds, by whether a query is using them or they wait idle',
  })
  const most = meter.createObservableUpDownCounter('db.client.connection.max', {
    description: 'The most connections a pool may hold',
  })
  const pending = meter.createObservableUpDownCounter('db.client.connection.pending_requests', {
    description: 'Queries waiting for a pool to give them a connection',
  })
  meter.addBatchObservableCallback(
    (result) => {
      for (const [name, read] of Object.entries(counts)) {
        const now = read()
        if (now === null) continue
        const labels = { 'db.client.connection.pool.name': name, role }
        result.observe(connections, now.total - now.idle, { ...labels, 'db.client.connection.state': 'used' })
        result.observe(connections, now.idle, { ...labels, 'db.client.connection.state': 'idle' })
        result.observe(most, now.max, labels)
        result.observe(pending, now.waiting, labels)
      }
    },
    [connections, most, pending],
  )
}

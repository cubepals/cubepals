// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The figures only the database knows, read as Prometheus scrapes: servers by state and region,
 * players online by region, jobs waiting by queue, and operations open by kind. Registered by the
 * worker role alone, so one source answers for the deployment; with several workers each reports
 * the same figures, and a dashboard takes the max, not the sum.
 *
 * Not for what happens once (a join, a wake, an operation's end): that is `app/platform/telemetry.ts`.
 */
import type { Db } from '@blockly/db'
import { metrics } from '@opentelemetry/api'
import { sql } from 'drizzle-orm'

/** The Postgres schema pg-boss keeps its jobs in (`infra/pg/jobs.ts`). */
const BOSS_SCHEMA = 'pgboss'

/** What a server's status counts as: the states a person reads, or `busy` while one changes. */
const STATE_OF: Record<string, string> = {
  running: 'running',
  stopped: 'asleep',
  stored: 'resting',
  failed: 'failed',
}

const rows = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> =>
  (await db.execute(query)).rows as T[]

/** Servers by the state a person reads and the region, trashed ones apart from the rest. */
async function serversByState(db: Db): Promise<Array<{ state: string; region: string; n: number }>> {
  const found = await rows<{ region: string; status: string; trashed: boolean; n: number }>(
    db,
    sql`select region_key as region, status::text as status, deleted_at is not null as trashed, count(*)::int as n
      from minecraft_servers where status <> 'purged' group by 1, 2, 3`,
  )
  const counts = new Map<string, { state: string; region: string; n: number }>()
  for (const { region, status, trashed, n } of found) {
    const state = trashed ? 'trashed' : (STATE_OF[status] ?? 'busy')
    const key = `${state}/${region}`
    counts.set(key, { state, region, n: (counts.get(key)?.n ?? 0) + n })
  }
  return [...counts.values()]
}

const playersByRegion = (db: Db) =>
  rows<{ region: string; n: number }>(
    db,
    sql`select s.region_key as region, count(*)::int as n
      from server_presence p join minecraft_servers s on s.id = p.server_id
      where s.deleted_at is null group by 1`,
  )

const jobsWaiting = (db: Db) =>
  rows<{ queue: string; n: number }>(
    db,
    sql`select name as queue, count(*)::int as n from ${sql.identifier(BOSS_SCHEMA)}.job
      where state in ('created', 'retry') group by 1`,
  )

const operationsOpen = (db: Db) =>
  rows<{ kind: string; status: string; n: number; age: number }>(
    db,
    sql`select kind::text as kind, status::text as status, count(*)::int as n,
        extract(epoch from now() - min(created_at))::float8 as age
      from server_operations where status in ('queued', 'running') group by 1, 2`,
  )

/** Registers the gauges, which read `db` each time Prometheus scrapes. */
export function observeDatabase(db: Db): void {
  const meter = metrics.getMeter('cubepals')
  const servers = meter.createObservableGauge('cubepals_servers', {
    description: 'Servers by state (running, asleep, resting, failed, busy, trashed) and region',
  })
  const players = meter.createObservableGauge('cubepals_players_online', {
    description: 'Players on a server now, by the region the server is in',
  })
  const queue = meter.createObservableGauge('cubepals_queue_depth', {
    description: 'Jobs waiting to be worked, by queue',
  })
  const open = meter.createObservableGauge('cubepals_operations_open', {
    description: 'Server operations queued or running, by kind',
  })
  const oldestQueued = meter.createObservableGauge('cubepals_operations_oldest_queued_seconds', {
    description: 'Seconds since the oldest queued server operation was queued, by kind',
    unit: 's',
  })
  meter.addBatchObservableCallback(
    async (result) => {
      const [byState, online, queues, operations] = await Promise.all([
        serversByState(db),
        playersByRegion(db),
        jobsWaiting(db),
        operationsOpen(db),
      ])
      for (const { state, region, n } of byState) result.observe(servers, n, { state, server_region: region })
      for (const { region, n } of online) result.observe(players, n, { server_region: region })
      for (const { queue: name, n } of queues) result.observe(queue, n, { queue: name })
      for (const { kind, status, n, age } of operations) {
        result.observe(open, n, { kind, status })
        if (status === 'queued') result.observe(oldestQueued, age, { kind })
      }
    },
    [servers, players, queue, open, oldestQueued],
  )
}

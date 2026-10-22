// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What Postgres itself says of its load: connections in use against `max_connections`, the oldest
 * open transaction, how often a read is served from memory, the database's size, and how far
 * replicas lag. Read every half minute, by the worker role alone, over one connection of its own,
 * with one statement that reads only Postgres's statistics views; the gauges report the last read,
 * so a scrape never waits on the database, and report nothing until a read has succeeded.
 *
 * Postgres is read rather than Supabase's metrics endpoint: the same figures come from every
 * database the control plane runs on (staging's is no Supabase project), and Fly's Prometheus
 * scrapes only machines in the organization, which that endpoint is not.
 *
 * Not for what this process sees of the database (`pools.ts`), or the product's figures (`gauges.ts`).
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { createPool } from '@blockly/db'
import { metrics } from '@opentelemetry/api'

const READ_EVERY_MS = 30 * SECOND_MS

/**
 * Client backends are what `max_connections` limits, so Postgres's own processes are left out of
 * `connections`. The oldest transaction is anyone's but this connection's own, timed by the clock
 * rather than `now()`, which is this statement's own start; a role without
 * pg_read_all_stats sees only its own role's. Replication lag is the longest replica's, null with none.
 */
const STATS = `select
  (select count(*) from pg_stat_activity where backend_type = 'client backend')::int as connections,
  current_setting('max_connections')::int as max_connections,
  (select greatest(extract(epoch from max(clock_timestamp() - xact_start)), 0) from pg_stat_activity
    where xact_start is not null and pid <> pg_backend_pid())::float8 as oldest_transaction,
  (select blks_hit::float8 / nullif(blks_hit + blks_read, 0) from pg_stat_database
    where datname = current_database()) as cache_hit_ratio,
  pg_database_size(current_database())::float8 as size,
  (select extract(epoch from max(replay_lag)) from pg_stat_replication)::float8 as replication_lag`

interface Stats {
  connections: number
  max_connections: number
  oldest_transaction: number | null
  cache_hit_ratio: number | null
  size: number
  replication_lag: number | null
}

/** Starts reading `url`'s statistics and registers the gauges that report them. Returns how to stop. */
export function readPostgres(url: string): () => Promise<void> {
  const pool = createPool(url, 1)
  let last: Stats | null = null
  let failing = false
  const read = async () => {
    try {
      last = (await pool.query<Stats>(STATS)).rows[0] ?? null
      failing = false
    } catch (error) {
      // Said once as reads start failing, not every half minute while they do.
      if (!failing) console.error('metrics: Postgres’s statistics could not be read', error)
      failing = true
    }
  }
  void read()
  const timer = setInterval(() => void read(), READ_EVERY_MS)
  timer.unref()

  const meter = metrics.getMeter('cubepals')
  const gauge = (name: string, description: string, unit?: string) =>
    meter.createObservableGauge(name, { description, ...(unit ? { unit } : {}) })
  const connections = gauge(
    'cubepals_db_connections',
    'Client connections Postgres holds now, from every app',
  )
  const most = gauge('cubepals_db_max_connections', 'Postgres’s max_connections')
  const oldest = gauge('cubepals_db_oldest_transaction_seconds', 'Age of the oldest open transaction', 's')
  const hits = gauge(
    'cubepals_db_cache_hit_ratio',
    'Share of reads served from memory since stats were reset',
  )
  const size = gauge('cubepals_db_size_bytes', 'The database’s size on disk', 'By')
  const lag = gauge(
    'cubepals_db_replication_lag_seconds',
    'How far the furthest replica lags; absent with none',
    's',
  )
  meter.addBatchObservableCallback(
    (result) => {
      if (last === null) return
      result.observe(connections, last.connections)
      result.observe(most, last.max_connections)
      result.observe(oldest, last.oldest_transaction ?? 0)
      if (last.cache_hit_ratio !== null) result.observe(hits, last.cache_hit_ratio)
      result.observe(size, last.size)
      if (last.replication_lag !== null) result.observe(lag, last.replication_lag)
    },
    [connections, most, oldest, hits, size, lag],
  )
  return async () => {
    clearInterval(timer)
    await pool.end()
  }
}

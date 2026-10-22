// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Serves what the process counts in Prometheus's format, for Fly's managed Prometheus to scrape
 * (`[metrics]` in infra/fly/*.toml). It listens on its own port, which no Fly service publishes,
 * so only the private network reaches it.
 *
 * Not for the figures themselves: those are counted where they happen (`opentelemetry.ts`,
 * `pools.ts`, `process.ts`), read from the database as a scrape comes (`gauges.ts`), or read from
 * Postgres's statistics on a timer (`postgres.ts`). pg-boss times its jobs itself, on the provider
 * registered here.
 */
import { createDb } from '@blockly/db'
import { metrics } from '@opentelemetry/api'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'
import { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { Pool } from 'pg'
import type { PgBoss } from 'pg-boss'
import type { Telemetry } from '../../app/ports/telemetry.ts'
import { observeDatabase } from './gauges.ts'
import { openTelemetry } from './opentelemetry.ts'
import { measurePools } from './pools.ts'
import { readPostgres } from './postgres.ts'
import { measureProcess } from './process.ts'

/**
 * Starts serving `/metrics` on `listen` (a `host:port`; nothing where it is unset), and returns the
 * telemetry that feeds it and how to stop what reads Postgres. Call it before `database.pool` opens
 * a connection, so every query is timed. The worker role alone reports the figures the database
 * holds, through the pool, and reads Postgres's statistics at `database.url`.
 */
export function serveMetrics(
  listen: string | undefined,
  roles: readonly string[],
  database: { pool: Pool; boss: PgBoss; url: string },
): { telemetry: Telemetry; stop: () => Promise<void> } {
  let stop = async () => {}
  if (listen !== undefined) {
    const at = listen.lastIndexOf(':')
    const exporter = new PrometheusExporter({
      host: listen.slice(0, at).replace(/^\[|\]$/g, ''),
      port: Number(listen.slice(at + 1)),
      withoutScopeInfo: true,
      withoutTargetInfo: true,
    })
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [exporter] }))
    const role = roles.join('+')
    measureProcess(role)
    measurePools(role, database.pool, database.boss)
    if (roles.includes('worker')) {
      observeDatabase(createDb(database.pool))
      stop = readPostgres(database.url)
    }
  }
  return { telemetry: openTelemetry(), stop }
}

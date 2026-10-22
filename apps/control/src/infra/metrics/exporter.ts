// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Serves what the process counts in Prometheus's format, for Fly's managed Prometheus to scrape
 * (`[metrics]` in infra/fly/*.toml). It listens on its own port, which no Fly service publishes,
 * so only the private network reaches it.
 *
 * Not for the figures themselves: those are counted where they happen (`opentelemetry.ts`), or
 * read from the database as a scrape comes (`gauges.ts`).
 */
import { createDb } from '@blockly/db'
import { metrics } from '@opentelemetry/api'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'
import { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { Pool } from 'pg'
import type { Telemetry } from '../../app/ports/telemetry.ts'
import { observeDatabase } from './gauges.ts'
import { openTelemetry } from './opentelemetry.ts'

/**
 * Starts serving `/metrics` on `listen` (a `host:port`; nothing where it is unset), and returns the
 * telemetry that feeds it. The worker role alone reports the figures the database holds, through `pool`.
 */
export function serveMetrics(listen: string | undefined, roles: readonly string[], pool: Pool): Telemetry {
  if (listen !== undefined) {
    const at = listen.lastIndexOf(':')
    const exporter = new PrometheusExporter({
      host: listen.slice(0, at).replace(/^\[|\]$/g, ''),
      port: Number(listen.slice(at + 1)),
      withoutScopeInfo: true,
      withoutTargetInfo: true,
    })
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [exporter] }))
    if (roles.includes('worker')) observeDatabase(createDb(pool))
  }
  return openTelemetry()
}

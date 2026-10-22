// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the edge counts and times, served in Prometheus's format for Fly to scrape (`[metrics]` in
 * infra/fly/edge.toml) on METRICS_LISTEN, a port no Fly service publishes; nothing is served where
 * it is unset. `docs/metrics.md` says what each figure means.
 *
 * Labels are few and fixed by the code: never a server, player or address. Not for deciding
 * anything: nothing here is read back.
 */
import { metrics } from '@opentelemetry/api'
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'
import { MeterProvider } from '@opentelemetry/sdk-metrics'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'

const listen = process.env.METRICS_LISTEN
if (listen) {
  const colon = listen.lastIndexOf(':')
  const exporter = new PrometheusExporter({
    host: listen.slice(0, colon),
    port: Number(listen.slice(colon + 1)),
    withoutScopeInfo: true,
    withoutTargetInfo: true,
  })
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [exporter] }))
}

const meter = metrics.getMeter('cubepals-edge')

/** Seconds, for what a player waits through. */
const WAIT_BUCKETS = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 45, 60, 90, 120, 180]
/** Seconds, for a request to the control plane. */
const REQUEST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]

const holdDuration = meter.createHistogram('cubepals_edge_hold_duration_seconds', {
  description: 'How long the waiting room held a join, by how it ended and, if turned away, why',
  unit: 's',
  advice: { explicitBucketBoundaries: WAIT_BUCKETS },
})
const held = meter.createUpDownCounter('cubepals_edge_held_joins', {
  description: 'Joins the waiting room holds now',
})
const pollDuration = meter.createHistogram('cubepals_edge_route_poll_duration_seconds', {
  description: 'How long asking the control plane for routes took, by whether it answered',
  unit: 's',
  advice: { explicitBucketBoundaries: REQUEST_BUCKETS },
})

let polledAt = Date.now()
meter
  .createObservableGauge('cubepals_edge_route_poll_age_seconds', {
    description: 'Seconds since the control plane last answered a route poll',
    unit: 's',
  })
  .addCallback((result) => result.observe((Date.now() - polledAt) / SECOND_MS))

/** A join entered the waiting room; call the result with how it ended. */
export function holdBegun(): (outcome: 'let_in' | 'turned_away' | 'gave_up', reason?: string) => void {
  const began = Date.now()
  held.add(1)
  return (outcome, reason) => {
    held.add(-1)
    holdDuration.record((Date.now() - began) / SECOND_MS, { outcome, reason: reason ?? 'none' })
  }
}

/** Runs a route poll, timing it; it counts as answered unless it throws. */
export async function polled<T>(poll: () => Promise<T>): Promise<T> {
  const began = Date.now()
  let answered = false
  try {
    const result = await poll()
    answered = true
    polledAt = Date.now()
    return result
  } finally {
    pollDuration.record((Date.now() - began) / SECOND_MS, { answered })
  }
}

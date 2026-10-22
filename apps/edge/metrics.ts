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

/** The region this edge machine runs in. Fly overwrites a label named `region`, so it is `edge_region`. */
const EDGE_REGION = process.env.FLY_REGION || 'unknown'

/** Seconds, for what a player waits through. */
const WAIT_BUCKETS = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 45, 60, 90, 120, 180]
/** Seconds, for a request to the control plane, or a server's first answer to a player. */
const REQUEST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]
/** Seconds late: under a millisecond is a loop at rest, a second is a process that stalls. */
const LAG_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
/** How often the event loop's lag is sampled. */
const LAG_SAMPLE_MS = 500

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

const connections = meter.createCounter('cubepals_edge_connections', {
  description: 'Connections the front door took, by edition, how their greeting ended, and why',
})
const proxied = meter.createCounter('cubepals_edge_proxied_bytes', {
  description: 'Bytes passed between players and servers, by edition and direction',
  unit: 'By',
})
const firstByte = meter.createHistogram('cubepals_edge_first_byte_seconds', {
  description: 'From a connection being accepted to the first byte back from what it was handed to',
  unit: 's',
  advice: { explicitBucketBoundaries: REQUEST_BUCKETS },
})
const lag = meter.createHistogram('cubepals_event_loop_lag_seconds', {
  description: 'How much later than asked the event loop ran a timer',
  unit: 's',
  advice: { explicitBucketBoundaries: LAG_BUCKETS },
})

// A timer's lateness reads the same under Bun as under Node, unlike event-loop utilization.
const sampleLag = () => {
  const began = performance.now()
  setTimeout(() => {
    lag.record(Math.max(0, performance.now() - began - LAG_SAMPLE_MS) / SECOND_MS, { role: 'edge' })
    sampleLag()
  }, LAG_SAMPLE_MS).unref()
}
if (listen) sampleLag()
meter
  .createObservableGauge('cubepals_heap_used_bytes', { description: 'JavaScript heap in use', unit: 'By' })
  .addCallback((result) => result.observe(process.memoryUsage().heapUsed, { role: 'edge' }))

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

/** Java players connect to the front door; Bedrock players' connections come through Geyser. */
export type Edition = 'java' | 'bedrock'

/**
 * A connection's greeting ended: `accepted` once what it was handed to first answered, `refused`
 * by the edge (`address`, `busy`, `wrong_game`), or `failed` (`silent`, `closed`, `bad_greeting`,
 * `greeting_timeout`, `backend`, `left`). Each connection is counted once.
 */
export function connectionEnded(
  edition: Edition,
  outcome: 'accepted' | 'refused' | 'failed',
  reason = 'none',
) {
  connections.add(1, { edition, outcome, reason, edge_region: EDGE_REGION })
}

/** The first byte came back for a connection accepted `ms` ago. */
export function firstByteAfter(edition: Edition, intent: 'join' | 'ping', ms: number): void {
  firstByte.record(Math.max(0, ms) / SECOND_MS, { edition, intent, edge_region: EDGE_REGION })
}

/** A connection let through closed, having passed `up` bytes from the player and `down` to them. */
export function connectionClosed(edition: Edition, up: number, down: number): void {
  proxied.add(up, { edition, direction: 'up', edge_region: EDGE_REGION })
  proxied.add(down, { edition, direction: 'down', edge_region: EDGE_REGION })
}

/** Whether Geyser is up, read as Prometheus scrapes: 1 or 0, and nothing where Bedrock isn't taken. */
export function observeGeyser(up: () => boolean | null): void {
  meter
    .createObservableGauge('cubepals_edge_geyser_up', {
      description: 'Whether Geyser runs and answers, so Bedrock players can join',
    })
    .addCallback((result) => {
      const now = up()
      if (now !== null) result.observe(now ? 1 : 0, { edge_region: EDGE_REGION })
    })
}

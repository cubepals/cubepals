// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { SECOND_MS } from '@blockly/contracts/durations'
import { metrics } from '@opentelemetry/api'

/** How often the event loop's lag is sampled. */
const SAMPLE_MS = 500
/** Seconds late: under a millisecond is a loop at rest, a second is a process that stalls. */
const LAG_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]

/**
 * How the process itself is doing: how late its event loop runs a timer, and the heap in use.
 * A timer's lateness reads the same under Node and Bun, which OpenTelemetry's runtime
 * instrumentation doesn't: it reads Node's event-loop utilization, which Bun reports as zero.
 */
export function measureProcess(role: string): void {
  const meter = metrics.getMeter('cubepals')
  const lag = meter.createHistogram('cubepals_event_loop_lag_seconds', {
    description: 'How much later than asked the event loop ran a timer',
    unit: 's',
    advice: { explicitBucketBoundaries: LAG_BUCKETS },
  })
  const sample = () => {
    const began = performance.now()
    setTimeout(() => {
      lag.record(Math.max(0, performance.now() - began - SAMPLE_MS) / SECOND_MS, { role })
      sample()
    }, SAMPLE_MS).unref()
  }
  sample()
  meter
    .createObservableGauge('cubepals_heap_used_bytes', { description: 'JavaScript heap in use', unit: 'By' })
    .addCallback((result) => result.observe(process.memoryUsage().heapUsed, { role }))
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The control plane's own figures (`ports/telemetry.ts`) as OpenTelemetry instruments on the
 * registered provider. Names, labels and buckets are `docs/metrics.md`'s.
 *
 * Not for serving them (`exporter.ts`), or for the figures the database holds (`gauges.ts`).
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { metrics } from '@opentelemetry/api'
import type { Telemetry } from '../../app/ports/telemetry.ts'

/** Seconds, for waits a player sits through: a join, a wake. */
const WAIT_BUCKETS = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 45, 60, 90, 120, 180]
/** Seconds, for operations, which take from moments to the half hour. */
const OPERATION_BUCKETS = [1, 5, 10, 20, 30, 60, 90, 120, 180, 300, 600, 1200, 1800]

const seconds = (ms: number) => Math.max(0, ms) / SECOND_MS

/** Instruments on the provider registered now: register it first, or they do nothing. */
export function openTelemetry(): Telemetry {
  const meter = metrics.getMeter('cubepals')
  const operationDuration = meter.createHistogram('cubepals_operation_duration_seconds', {
    description: 'How long a server operation took from queued to ended',
    unit: 's',
    advice: { explicitBucketBoundaries: OPERATION_BUCKETS },
  })
  const operationFailures = meter.createCounter('cubepals_operation_failures', {
    description: 'Server operations that ended failed, by the step they had reached',
  })
  const joinDuration = meter.createHistogram('cubepals_join_duration_seconds', {
    description: 'How long a join took from the player’s handshake to being in the world',
    unit: 's',
    advice: { explicitBucketBoundaries: WAIT_BUCKETS },
  })
  const wakeDuration = meter.createHistogram('cubepals_wake_duration_seconds', {
    description: 'How long a wake took from the edge asking for it to the server being ready',
    unit: 's',
    advice: { explicitBucketBoundaries: WAIT_BUCKETS },
  })
  const wakeAnswers = meter.createCounter('cubepals_wake_answers', {
    description: 'What the control plane answered the edge when it asked for a server to wake',
  })
  return {
    operationEnded: (kind, outcome, ms) => operationDuration.record(seconds(ms), { kind, outcome }),
    operationFailed: (kind, step) => operationFailures.add(1, { kind, step: step ?? 'none' }),
    joinCompleted: (path, edgeRegion, ms) =>
      joinDuration.record(seconds(ms), { path: path ?? 'unknown', edge_region: edgeRegion ?? 'unknown' }),
    wakeCompleted: (edgeRegion, ms) =>
      wakeDuration.record(seconds(ms), { edge_region: edgeRegion ?? 'unknown' }),
    wakeAnswered: (outcome, reason) => wakeAnswers.add(1, { outcome, reason: reason ?? 'none' }),
    observeRealtime: (read) => {
      const browsers = meter.createObservableGauge('cubepals_realtime_browsers', {
        description: 'Browsers connected to the realtime role now',
      })
      const tails = meter.createObservableGauge('cubepals_realtime_console_tails', {
        description: 'Server consoles the realtime role is following for someone watching',
      })
      meter.addBatchObservableCallback(
        (result) => {
          const now = read()
          result.observe(browsers, now.browsers)
          result.observe(tails, now.tails)
        },
        [browsers, tails],
      )
    },
  }
}

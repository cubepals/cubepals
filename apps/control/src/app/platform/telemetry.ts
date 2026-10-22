// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the control plane counts and times as it runs, handed to the telemetry installed at
 * startup (`ports/telemetry.ts`, served by `infra/metrics/`). Until one is installed, as in tests
 * and local runs, every call here does nothing. `docs/metrics.md` says what each figure means.
 *
 * Not for the figures only the database knows (servers by state, queue depth): those are read as
 * a monitor scrapes, in `infra/metrics/gauges.ts`.
 */
import type { Telemetry } from '../ports/telemetry.ts'

let installed: Telemetry | null = null

/** Installs the telemetry every call below goes to, and hands it back. */
export function installTelemetry(telemetry: Telemetry): Telemetry {
  installed = telemetry
  return telemetry
}

export const operationEnded: Telemetry['operationEnded'] = (...args) => installed?.operationEnded(...args)
export const operationFailed: Telemetry['operationFailed'] = (...args) => installed?.operationFailed(...args)
export const joinCompleted: Telemetry['joinCompleted'] = (...args) => installed?.joinCompleted(...args)
export const wakeCompleted: Telemetry['wakeCompleted'] = (...args) => installed?.wakeCompleted(...args)
export const wakeAnswered: Telemetry['wakeAnswered'] = (...args) => installed?.wakeAnswered(...args)
export const requestServed: Telemetry['requestServed'] = (...args) => installed?.requestServed(...args)
export const procedureServed: Telemetry['procedureServed'] = (...args) => installed?.procedureServed(...args)
export const realtimeConnected: Telemetry['realtimeConnected'] = (...args) =>
  installed?.realtimeConnected(...args)
export const observeRealtime: Telemetry['observeRealtime'] = (...args) => installed?.observeRealtime(...args)

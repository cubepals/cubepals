// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the control plane counts and times as it runs, handed to the telemetry installed at
 * startup (`ports/telemetry.ts`, served by `infra/metrics/`). Until one is installed, as in tests
 * and local runs, every call here does nothing. `docs/metrics.md` says what each figure means.
 * Installed with a database, the same calls also keep what ran slow or failed, with whose it was
 * (`app/diagnostics/`), as do the queries the telemetry hears.
 *
 * Not for the figures only the database knows (servers by state, queue depth): those are read as
 * a monitor scrapes, in `infra/metrics/gauges.ts`.
 */
import type { Db } from '@blockly/db'
import { DiagnosticsRecorder } from '../diagnostics/recorder.ts'
import { DiagnosticsService } from '../diagnostics/service.ts'
import type { Telemetry } from '../ports/telemetry.ts'

let installed: Telemetry | null = null
let recorder: DiagnosticsRecorder | null = null
let stopRecording: (() => Promise<void>) | null = null

/**
 * Installs the telemetry every call below goes to, and hands it back. With `record`, what ran slow
 * or failed is kept in its database too, in the name of the process's `roles`; without, nothing is.
 */
export function installTelemetry(
  telemetry: Telemetry,
  record?: { db: Db; roles: readonly string[] },
): Telemetry {
  installed = telemetry
  void stopRecording?.()
  recorder = null
  stopRecording = null
  if (record !== undefined) {
    const service = new DiagnosticsService(record.db)
    const keeping = new DiagnosticsRecorder(record.roles.join('+'), (records) => service.write(records))
    recorder = keeping
    stopRecording = keeping.start()
    telemetry.watchQueries((statement, ms, error) => keeping.query(statement, ms, error))
  }
  return telemetry
}

/** Writes what the recorder holds, and stops it: as the process stops, before its pool closes. */
export async function stopTelemetry(): Promise<void> {
  const stopping = stopRecording
  recorder = null
  stopRecording = null
  await stopping?.()
}

export const operationEnded: Telemetry['operationEnded'] = (...args) => installed?.operationEnded(...args)
export const operationFailed: Telemetry['operationFailed'] = (...args) => installed?.operationFailed(...args)
export const joinCompleted: Telemetry['joinCompleted'] = (...args) => installed?.joinCompleted(...args)
export const wakeCompleted: Telemetry['wakeCompleted'] = (...args) => installed?.wakeCompleted(...args)
export const wakeAnswered: Telemetry['wakeAnswered'] = (...args) => installed?.wakeAnswered(...args)
export const requestServed: Telemetry['requestServed'] = (listener, route, method, status, ms) => {
  installed?.requestServed(listener, route, method, status, ms)
  recorder?.served('request', `${method} ${route}`, status, ms)
}
export const procedureServed: Telemetry['procedureServed'] = (procedure, status, ms) => {
  installed?.procedureServed(procedure, status, ms)
  recorder?.served('procedure', procedure, status, ms)
}
export const realtimeConnected: Telemetry['realtimeConnected'] = (...args) =>
  installed?.realtimeConnected(...args)
export const observeRealtime: Telemetry['observeRealtime'] = (...args) => installed?.observeRealtime(...args)

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writes what a runtime said about a server's compute into the server's `observed` record, as the
 * schedules keep it: its state and when, and why it stopped or that its host was lost. Asking the
 * provider, and what to do about what it says, are the jobs' own (`reconcile.ts`, `relocations.ts`,
 * `presence.ts`).
 */
import type { Db, ObservedJson } from '@blockly/db'
import type { RuntimeObservation } from '../../ports/runtime.ts'
import { HOST_LOST, OUT_OF_MEMORY, saveObserved } from '../../servers/persistence.ts'

export const observedJson = (observation: RuntimeObservation): ObservedJson => ({
  state: observation.state,
  at: observation.at.toISOString(),
  ...(observation.hostLost
    ? { detail: HOST_LOST }
    : observation.exit
      ? { detail: observation.exit.oom ? OUT_OF_MEMORY : `exit ${observation.exit.code}` }
      : {}),
})

/** A lost host, recorded as first seen: the grace before its server is rebuilt counts from then. */
export async function recordHostLost(db: Db, serverId: string, seen: RuntimeObservation): Promise<void> {
  await saveObserved(db, serverId, { state: 'unknown', at: seen.at.toISOString(), detail: HOST_LOST })
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Starts the servers whose last sleep was a stop, made so that their Java could write the
 * recording of its start (`handlers/winding-down.ts`, `minecraft/start-cache.ts`). The start makes
 * the startup cache with nobody waiting, and the server sleeps with its memory after the
 * probation, as it would have (`servers/refresh.ts`, which also bounds how often and on whose
 * hours).
 *
 * It runs with the idle check, each minute: until that start, a player who joins boots the server
 * where a sleep would have resumed it, so the wait is kept to the pass after the stop. A server
 * whose sleep is still writing its restore point waits for that: the copy is of the server as it
 * stopped. One with anything else going on, or started, stopped, restored or moved since, is left
 * alone, and so is one whose start was refused for a day.
 */
import { DAY_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { listByStatus } from '../../servers/persistence.ts'
import { activeOperation, lastStopsMarked, pendingOfKind } from '../persistence.ts'
import type { SleepMark } from '../runner.ts'

/** How long after a stop made for a recording its start is still tried. */
const TRIED_FOR_MS = DAY_MS
/** The mark of a stop made for a recording. */
const RECORDING = ['recording'] as const satisfies readonly SleepMark[]

export function recordedStarts(deps: { db: Db; refresh: (serverId: string) => Promise<boolean> }) {
  const { db, refresh } = deps

  /** Whether nothing stands between the server and its start. */
  const free = async (serverId: string): Promise<boolean> =>
    (await activeOperation(db, serverId)) === null && !(await pendingOfKind(db, serverId, 'backup'))

  /** Starts up to `limit` of them; how many it started. */
  return async (now = new Date(), limit = 3): Promise<number> => {
    const waiting = await lastStopsMarked(db, new Date(now.getTime() - TRIED_FOR_MS), RECORDING)
    if (waiting.length === 0) return 0
    const stopped = new Set((await listByStatus(db, 'stopped')).map((server) => server.id))
    let started = 0
    for (const { serverId: id } of waiting) {
      if (started >= limit) break
      if (stopped.has(id) && (await free(id)) && (await refresh(id))) started++
    }
    return started
  }
}

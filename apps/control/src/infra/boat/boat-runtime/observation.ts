// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Boat's and Docker's states, read as the port's observed states: a sandbox's state, and the
 * workload's `inspect` line. It asks Boat nothing: `boat-runtime.ts` reads a sandbox or runs
 * `inspect` and hands over the answer, and `sandboxes.ts` waits on the same states.
 */

import type { ObservedState, RuntimeObservation } from '../../../app/ports/runtime.ts'
import type { Sandbox } from '../client.ts'

export const UP = new Set(['ready', 'idle', 'running'])
export const COMING = new Set(['init', 'provisioning', 'provisioned', 'cloning'])

export function stateOf(state: string): ObservedState {
  if (COMING.has(state)) return 'starting'
  if (UP.has(state)) return 'running'
  if (state === 'archiving') return 'stopping'
  if (state === 'archived') return 'stopped'
  if (state === 'error') return 'crashed'
  if (state === 'cancelled') return 'absent'
  return 'unknown'
}

export function changedAt(sandbox: Sandbox, now: Date): Date {
  const at = Date.parse(sandbox.updatedAt ?? '')
  return Number.isNaN(at) || at > now.getTime() ? now : new Date(at)
}

/**
 * The container, as `inspect` prints it: status, exit code, killed for memory, restarts since
 * started, and when it started and last finished. Missing, soon after a resume, is Boat still
 * bringing it back.
 */
export function workloadObservation(line: string, now: Date): RuntimeObservation {
  const [status = 'missing', code = '0', oom = 'false', restarts = '0', startedAt = '', finishedAt = ''] =
    line.split(' ')
  const time = (text: string) => {
    const at = Date.parse(text)
    return Number.isNaN(at) || at <= 0 || at > now.getTime() ? null : new Date(at)
  }
  const finished = time(finishedAt)
  // Docker started it again after it stopped on its own: when that was.
  const failedAt = Number(restarts) > 0 && finished !== null ? { failedAt: finished } : {}
  switch (status) {
    case 'running':
      return { state: 'running', at: time(startedAt) ?? now, ...failedAt }
    case 'restarting':
      return { state: 'starting', at: now, ...failedAt }
    case 'missing':
      return { state: 'starting', at: now }
    case 'created':
      return { state: 'stopped', at: now }
    case 'exited':
    case 'dead': {
      const exit = { code: Number(code), oom: oom === 'true' }
      // 0, or 143 for the SIGTERM of a stop, is a stop; anything else stopped it.
      const crashed = (exit.code !== 0 && exit.code !== 143) || exit.oom
      return { state: crashed ? 'crashed' : 'stopped', at: finished ?? now, exit }
    }
    default:
      return { state: 'unknown', at: now }
  }
}

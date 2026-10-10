// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads a Fly machine's state and exit events as the port's observation: running, crashed and
 * when, or lost with its host. Pure: reading the machine from Fly belongs to `machines.ts`, and
 * listing the organization's changes to `discovery.ts`.
 */

import { z } from 'zod'
import type { ObservedState, RuntimeObservation } from '../../../app/ports/runtime.ts'
import type { FlySchemas } from '../client.ts'

type Machine = FlySchemas['Machine']

// The spec leaves machine events untyped; these are the only fields read, checked on the way in.
const ExitEvent = z.object({
  type: z.literal('exit'),
  timestamp: z.number().optional(),
  request: z
    .object({
      exit_event: z
        .object({
          exit_code: z.number().optional(),
          oom_killed: z.boolean().optional(),
          requested_stop: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
})
const UpdateEvent = z.object({ type: z.literal('update') })

export function stateOf(state: string | undefined): ObservedState {
  switch (state) {
    case 'started':
      return 'running'
    case 'created':
    case 'starting':
    case 'replacing':
    case 'updating':
      return 'starting'
    case 'stopping':
    case 'suspending':
      return 'stopping'
    case 'stopped':
    case 'suspended':
      return 'stopped'
    case 'destroyed':
    case 'destroying':
      return 'absent'
    case 'failed':
      return 'crashed'
    default:
      return 'unknown'
  }
}

export function lastExit(
  machine: Machine,
): { code: number; oom: boolean; requested: boolean; at: number } | null {
  const exits = (machine.events ?? [])
    .map((event) => ExitEvent.safeParse(event))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
  const exit = exits[0]
  if (!exit) return null
  const detail = exit.request?.exit_event
  // Updating a started machine stops its old run and launches the new one, and for a moment Fly
  // shows it stopped, the old run's exit not asked for (seen 2026-09-28: an update event, then an
  // exit with code 0 and `requested_stop: false`, half a second before the new run started). That
  // exit is the update's own: read as the new configuration failing, it rolled back a pack update
  // that was starting fine. The new run's events start afresh, so an exit after an update is always
  // the old run's.
  const replaced = (machine.events ?? []).some(
    (event) => UpdateEvent.safeParse(event).success && (event.timestamp ?? 0) <= (exit.timestamp ?? 0),
  )
  return {
    code: detail?.exit_code ?? 0,
    oom: detail?.oom_killed ?? false,
    requested: (detail?.requested_stop ?? false) || replaced,
    at: exit.timestamp ?? 0,
  }
}

export function observationOf(machine: Machine | null, now = new Date()): RuntimeObservation {
  if (machine === null) return { state: 'absent', at: now }
  // Fly can't reach the machine's host: what it last said about the machine is no longer news.
  if (machine.host_status === 'unreachable') return { state: 'unknown', at: now, hostLost: true }
  const state = stateOf(machine.state)
  const exit = lastExit(machine)
  if (state === 'stopped' && exit && !exit.requested && (exit.code !== 0 || exit.oom)) {
    // When it exited, as Fly recorded it: a crashed run's play time ends then, not when looked at.
    const exited = exit.at > 0 && exit.at <= now.getTime() ? new Date(exit.at) : now
    return { state: 'crashed', at: exited, exit: { code: exit.code, oom: exit.oom } }
  }
  // The restart policy (on-failure) starts it again after a failed exit, and the event stays.
  if (state !== 'stopped' && exit && !exit.requested && (exit.code !== 0 || exit.oom) && exit.at > 0)
    return { state, at: now, failedAt: new Date(exit.at) }
  return { state, at: now }
}

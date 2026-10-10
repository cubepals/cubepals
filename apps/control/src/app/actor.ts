// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { MinecraftServer } from '../domain/server/server.ts'
import { NotFound } from './errors.ts'

/** Who is asking. Services authorize by actor; interfaces only say who it is. */
export type Actor =
  | { kind: 'user'; userId: string }
  | { kind: 'admin'; userId: string }
  | {
      kind: 'system'
      reason:
        | 'wake'
        | 'idle'
        | 'policy'
        | 'entitlement'
        | 'reconcile'
        | 'session_cap'
        | 'invite'
        /** A server that was made for a while, once its time is up. */
        | 'expired'
        /** A world that needs a bigger disk while people play on it. */
        | 'disk'
        /** The spend watchdog, pausing starts and creation once a day passes its limit. */
        | 'spend'
    }
  /** Someone running the deployment through the operators' API (`interfaces/operator/`), by name. */
  | { kind: 'operator'; name: string }

export type UserActor = Extract<Actor, { kind: 'user' }>
export type OperatorActor = Extract<Actor, { kind: 'operator' }>

export function requestedBy(actor: Actor): string {
  if (actor.kind === 'system') return `system:${actor.reason}`
  if (actor.kind === 'operator') return `operator:${actor.name}`
  return `${actor.kind}:${actor.userId}`
}

/** Whoever runs the platform: an admin signed in, or an operator through the operators' API. */
export const runsThePlatform = (actor: Actor): boolean => actor.kind === 'admin' || actor.kind === 'operator'

/** People reach only their own servers; everything else looks like it does not exist. */
export function authorize(actor: Actor, server: MinecraftServer | null): MinecraftServer {
  if (server === null) throw new NotFound('Server')
  if (actor.kind === 'user' && server.ownerId !== actor.userId) throw new NotFound('Server')
  return server
}

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

export type UserActor = Extract<Actor, { kind: 'user' }>

export const requestedBy = (actor: Actor): string =>
  actor.kind === 'system' ? `system:${actor.reason}` : `${actor.kind}:${actor.userId}`

/** People reach only their own servers; everything else looks like it does not exist. */
export function authorize(actor: Actor, server: MinecraftServer | null): MinecraftServer {
  if (server === null) throw new NotFound('Server')
  if (actor.kind === 'user' && server.ownerId !== actor.userId) throw new NotFound('Server')
  return server
}

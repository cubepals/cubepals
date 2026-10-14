// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edge protocol, v1, that any Minecraft edge router speaks to the control plane: the routes
 * it polls, the wakes it asks for, its idle hints and the sessions it saw.
 */
import { z } from 'zod'

/**
 * The edge protocol, v1: what any Minecraft edge router speaks to the control plane. The control
 * plane resolves hostnames and destinations; the edge only forwards. Nothing here names a
 * particular router.
 */
export const EDGE_PROTOCOL_BASE = '/edge/v1'

export const EdgeRoute = z.object({
  hostname: z.string(),
  /** `host:port`, reachable from the edge's network. */
  destination: z.string(),
  /**
   * Why a player can't be let in right now; absent while the server runs. `asleep` wakes when
   * someone joins. `restarting` comes back by itself, so the edge says so and dials nothing.
   */
  state: z.enum(['asleep', 'restarting']).optional(),
  /**
   * An asleep server whose owner has used the day's play their plan includes: when it is back, at
   * their midnight. The edge says so to a ping, in `play-today.ts`'s words.
   */
  backAt: z.iso.datetime().optional(),
  /**
   * An asleep server's own message, as the game reads it (section-sign codes), which the edge
   * shows a ping in place of its own notice. Absent while the message is still Blockly's welcome.
   */
  motd: z.string().optional(),
  /**
   * Where the edge fetches an asleep server's picture, a 64 square PNG, to show a ping. The link
   * changes whenever the picture does, so the edge fetches each once. Absent while it has none.
   */
  icon: z.url().optional(),
})
export const EdgeRoutes = z.object({ routes: z.array(EdgeRoute) })
export type EdgeRoutes = z.infer<typeof EdgeRoutes>

export const WakeRequest = z.object({ hostname: z.string() })
export const WakeResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ready'), destination: z.string() }),
  z.object({ outcome: z.literal('starting') }),
  /** Still on its way back from a restart after as long as a joining client waits. */
  z.object({ outcome: z.literal('restarting') }),
  z.object({
    outcome: z.literal('denied'),
    reason: z.enum(['unknown', 'suspended', 'paused', 'quota', 'deleted']),
    /** Refused because the day's play is used: when it is back, as on the route. */
    backAt: z.iso.datetime().optional(),
  }),
])
export type WakeResult = z.infer<typeof WakeResult>

export const IdleHint = z.object({ hostname: z.string() })

export const SessionEvent = z.object({
  edgeId: z.string(),
  hostname: z.string(),
  event: z.enum(['connect', 'disconnect']),
  /** Claimed by the client; never used for authorization. */
  player: z.object({ name: z.string(), uuid: z.string() }).optional(),
  at: z.iso.datetime(),
})
export type SessionEvent = z.infer<typeof SessionEvent>

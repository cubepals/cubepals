// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edge protocol, v1, that any Minecraft edge router speaks to the control plane: the routes
 * it polls, the wakes it asks for (a join's, and a ping's early one), its idle hints and the
 * sessions it saw.
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
  /**
   * A kept address, which Cubepals points at one of its own servers: that server's slug. The route
   * is otherwise that server's own, and a browser opening the address goes to that server's page.
   */
  aliasOf: z.string().optional(),
  /** `host:port`, reachable from the edge's network. */
  destination: z.string(),
  /**
   * Why a player can't be let in right now; absent while the server runs. `asleep` wakes when
   * someone joins. `restarting` comes back by itself, so the edge says so and dials nothing.
   */
  state: z.enum(['asleep', 'restarting']).optional(),
  /**
   * An asleep server whose owner has played all of their free trial's hours: no join wakes it
   * until their plan changes, and the edge says so to a ping and a join.
   */
  trialOver: z.literal(true).optional(),
  /**
   * The server's name, on a route resting for its owner's free trial, so the edge can say whose
   * server a refused join reached. Cubepals' welcome, shown to a ping while it runs, names it too.
   */
  name: z.string().optional(),
  /**
   * An asleep server already on its way up, woken by a join or a ping: the edge tells a ping it is
   * waking. A join still goes to the waiting room, as to any server that isn't running.
   */
  waking: z.literal(true).optional(),
  /**
   * An asleep server's wake, in whole seconds: the median of its own wakes the way it would wake
   * now (from memory, a boot or from rest), else of every server's (`wake-times.ts`). The edge
   * tells a ping of a waking server about how long is left. Absent with too few measured.
   */
  wakeSeconds: z.number().int().positive().optional(),
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
  /**
   * The server reads a PROXY protocol header (`proxy-header.ts`) before each connection, which tells
   * it the player's own address. Absent, it reads none, and a connection that opens with one fails.
   * It is the run the server is in that counts: one started before it read headers reads none
   * until its next start.
   */
  proxyProtocol: z.literal(true).optional(),
  /**
   * The players' games the server takes, by the protocol number a client names in its handshake:
   * from `oldest` to `newest`, or to any newer one where `newest` is absent. A join from outside
   * is turned away at once, naming `release`, the Minecraft the server runs, and nothing is woken;
   * a sleeping server's ping is answered with `release`'s number, so the list marks it as another
   * version. Absent, the edge takes every client, as before it was added.
   */
  joins: z
    .object({
      release: z.string(),
      protocol: z.number().int(),
      oldest: z.number().int(),
      newest: z.number().int().optional(),
    })
    .optional(),
})
export type EdgeRoute = z.infer<typeof EdgeRoute>
export const EdgeRoutes = z.object({
  routes: z.array(EdgeRoute),
  /**
   * Each Minecraft release and the protocol number its client speaks, newest first: how the edge
   * names a player's game when it can't join.
   */
  releases: z.array(z.object({ name: z.string(), protocol: z.number().int() })).optional(),
})
export type EdgeRoutes = z.infer<typeof EdgeRoutes>

/**
 * `understands`: answers newer than the edge protocol's first that this edge can word for a
 * player (`NEWER_REASONS` and `NEWER_OUTCOMES`, in `edge-poll.ts`). An edge that doesn't name one
 * is answered as before it was added.
 *
 * `name`: the name the joining client gave as it began to log in, where it gave one. Claimed by the
 * client. `address`: where the join came from, as the edge's front door read it. Together they
 * only choose which wakes a server's hour counts it among, never who may join: a name lifts the
 * hour's count only from a network the server's own players joined it from lately.
 */
export const WakeRequest = z.object({
  hostname: z.string(),
  understands: z.array(z.string()).optional(),
  name: z.string().max(16).optional(),
  address: z.string().optional(),
})
/** What a join said of itself as it asked for a wake. */
export type WakeClaim = Pick<z.infer<typeof WakeRequest>, 'name' | 'address'>
export const WakeResult = z.discriminatedUnion('outcome', [
  /**
   * `proxyProtocol` as on the server's route, for the run it is in now. `wakeOperationId`, here and
   * on `starting`: the start this wake asked for or found under way, where there was one.
   */
  z.object({
    outcome: z.literal('ready'),
    destination: z.string(),
    proxyProtocol: z.literal(true).optional(),
    wakeOperationId: z.string().optional(),
  }),
  /**
   * `behind`: the start waits for other work on the server to finish first, which the player is
   * told when the join can't wait any longer: its world being put to rest (`rest`), the server
   * going to sleep (`stop`), or a backup.
   */
  z.object({
    outcome: z.literal('starting'),
    behind: z.enum(['rest', 'stop', 'backup']).optional(),
    wakeOperationId: z.string().optional(),
  }),
  /** Still on its way back from a restart after as long as a joining client waits. */
  z.object({ outcome: z.literal('restarting') }),
  /** Left asleep: this join starts nothing now, and its player is told the server sleeps. */
  z.object({ outcome: z.literal('asleep') }),
  z.object({
    outcome: z.literal('denied'),
    /**
     * `failed`: its start failed for good in waking it, and the next join tries it again;
     * `broken`: it failed over what the server runs, which its owner sees and has to change.
     */
    reason: z.enum(['unknown', 'suspended', 'paused', 'quota', 'deleted', 'failed', 'broken']),
    /** Refused because the owner's free trial's hours are all played, as on the route. */
    trialOver: z.literal(true).optional(),
    /** The server's name, on a refusal for its owner's play: the player hears whose server it is. */
    name: z.string().optional(),
  }),
])
export type WakeResult = z.infer<typeof WakeResult>

/**
 * A server list asked how an asleep server is, which often comes just before a join: the control
 * plane may start it now, so the join finds it nearly up. It answers at once, without waiting for
 * the start; `waking` says whether the server is on its way up, by this ask or an earlier one.
 */
/**
 * `address`: where the ping came from, as the edge's front door read it; a ping wakes a server only
 * from its own players' network. An edge from before it sent one wakes nothing with a ping.
 */
export const PingWakeRequest = z.object({ hostname: z.string(), address: z.string().optional() })
export const PingWakeResult = z.object({ waking: z.boolean() })
export type PingWakeResult = z.infer<typeof PingWakeResult>

export const IdleHint = z.object({ hostname: z.string() })

export const SessionEvent = z.object({
  edgeId: z.string(),
  hostname: z.string(),
  event: z.enum(['connect', 'disconnect']),
  /** Claimed by the client; never used for authorization. */
  player: z.object({ name: z.string(), uuid: z.string() }).optional(),
  /** Where the client connected from, as the edge's front door read it. */
  address: z.string().optional(),
  at: z.iso.datetime(),
})
export type SessionEvent = z.infer<typeof SessionEvent>

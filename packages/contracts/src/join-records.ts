// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each join leaves behind, as the places that see it report it: the edge's half of each
 * connection (`VisitReport`), the game server's half from its reporter plugin (`ServerJoinEvent`),
 * and the kinds of signal the control plane raises on the record they make together, with the
 * shape of the `SIGNALS` setting that turns each kind on.
 *
 * Not for which versions can join a server: that is `joins.ts`.
 */
import { z } from 'zod'

/** A moment, in ISO 8601 with milliseconds. */
const At = z.iso.datetime()

/**
 * One connection at the edge, reported in halves sharing `joinId`: `open` once it is handed to the
 * server (or turned away), `close` once it has ended and the edge has waited a moment for a ping
 * after it, and `look` for a server-list ping that no join followed. A later half fills only what
 * an earlier one left out.
 */
export const VisitReport = z.object({
  joinId: z.uuid(),
  phase: z.enum(['open', 'close', 'look']),
  edgeId: z.string().min(1),
  region: z.string(),
  /** The hostname dialled, normalised: lower case, no trailing dot, no port. */
  address: z.string(),
  /** `ip:port` of the client, as the PROXY header said. */
  source: z.string(),
  protocol: z.number().int().optional(),
  /** Claimed by the client; never used for authorization. */
  player: z.object({ name: z.string().max(16), uuid: z.string().optional() }).optional(),
  /** How it reached the server: at once, through the waiting room, or not at all. */
  path: z.enum(['direct', 'held', 'refused']).optional(),
  pingedAt: At.optional(),
  connectedAt: At.optional(),
  wakeAskedAt: At.optional(),
  wakeOperationId: z.uuid().optional(),
  readyAt: At.optional(),
  handedAt: At.optional(),
  leftAt: At.optional(),
  leftReason: z.string().max(200).optional(),
  /** A ping from the same address within a moment of leaving: the player looked again. */
  pingedAfterAt: At.optional(),
  bytesUp: z.number().int().nonnegative().optional(),
  bytesDown: z.number().int().nonnegative().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
})
export type VisitReport = z.infer<typeof VisitReport>

/** How many reports or events one request may carry. */
export const MOST_PER_BATCH = 200

export const VisitBatch = z.object({ reports: z.array(VisitReport).max(MOST_PER_BATCH) })
export type VisitBatch = z.infer<typeof VisitBatch>

/**
 * One moment of a join as the game server saw it, from the reporter plugin, or the server's own
 * `boot`. `address` is the client's `ip:port` where the server knew it.
 */
export const ServerJoinEvent = z.object({
  kind: z.enum(['boot', 'login', 'configure_started', 'configured', 'in_world', 'left']),
  at: At,
  uuid: z.string().optional(),
  name: z.string().max(16).optional(),
  address: z.string().max(64).optional(),
  reason: z.string().max(200).optional(),
  tick: z.object({ tps: z.number(), mspt: z.number(), online: z.number().int() }).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
})
export type ServerJoinEvent = z.infer<typeof ServerJoinEvent>

export const ServerJoinBatch = z.object({ events: z.array(ServerJoinEvent).max(MOST_PER_BATCH) })
export type ServerJoinBatch = z.infer<typeof ServerJoinBatch>

/** Every kind of signal the control plane can raise about joins and the servers they reach. */
export const SIGNAL_KINDS = [
  'slow_join',
  'left_while_loading',
  'short_stay',
  'looked_back',
  'watched_address',
  'look_no_join',
  'wake_no_join',
  'repeated_wakes',
  'crowd',
  'kicked_early',
  'slow_tick',
  'legacy_login_listener',
] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

const Figure = z.number().positive()
/** A kind that is on with nothing to tune: present means on. */
const On = z.object({})

/**
 * The `SIGNALS` setting: which kinds run, and the limit each is measured against. A kind whose key
 * is absent never runs, and with no setting at all nothing does. Its values are the operators',
 * kept out of this repository.
 */
export const SignalsConfig = z.object({
  /** Addresses, by their first label, whose joins and looks are worth a signal of their own. */
  watchedAddresses: z.array(z.string().min(1)).optional(),
  /** Which servers the `…Ours…` limits apply to instead: the official ones. */
  ourServers: z.literal('official').optional(),
  slowJoin: z
    .object({
      loginToWorldS: Figure.optional(),
      loginToWorldOursS: Figure.optional(),
      /** From connecting to in the world, by how the wake found the server. */
      connectToWorldS: z
        .object({ memory: Figure.optional(), stopped: Figure.optional(), atRest: Figure.optional() })
        .optional(),
    })
    .optional(),
  leftWhileLoading: On.optional(),
  shortStay: z.object({ underS: Figure.optional() }).optional(),
  lookedBack: z.object({ pingWithinS: Figure.optional(), noRejoinS: Figure.optional() }).optional(),
  watchedAddress: On.optional(),
  lookNoJoin: z
    .object({ watchedEveryOne: z.boolean().optional(), digestMinutes: Figure.optional() })
    .optional(),
  wakeNoJoin: z
    .object({ perServerPerDay: Figure.optional(), oursAnyFromWatched: z.boolean().optional() })
    .optional(),
  repeatedWakes: z.object({ perServerPerHour: Figure.optional() }).optional(),
  crowd: z
    .object({
      playersIn10Min: Figure.optional(),
      oursPlayersIn10Min: Figure.optional(),
      platformHourOverAverage: Figure.optional(),
    })
    .optional(),
  kickedEarly: z.object({ withinS: Figure.optional() }).optional(),
  slowTick: z.object({ msptOver: Figure.optional() }).optional(),
  legacyLoginListener: z.object({ oursOnly: z.boolean().optional() }).optional(),
})
export type SignalsConfig = z.infer<typeof SignalsConfig>

// ─── As operators read them (`/ops/v1/joins`, `/ops/v1/signals`) ────────────────────────────────

/**
 * A join as an operator reads it: every column but the client's address and its network's hash,
 * with the server's name. Moments are ISO, null where nobody said.
 */
export interface JoinView {
  id: string
  kind: 'join' | 'look'
  serverId: string | null
  serverName: string | null
  edgeId: string | null
  edgeRegion: string | null
  address: string
  addressKind: 'own' | 'kept' | 'old_domain' | null
  protocol: number | null
  playerName: string | null
  playerUuid: string | null
  path: 'direct' | 'held' | 'refused' | null
  pingedAt: string | null
  connectedAt: string
  wakeAskedAt: string | null
  wakeOperationId: string | null
  readyAt: string | null
  handedAt: string | null
  loginAt: string | null
  configureStartedAt: string | null
  configuredAt: string | null
  inWorldAt: string | null
  leftAt: string | null
  leftReason: string | null
  pingedAfterAt: string | null
  bytesUp: number | null
  bytesDown: number | null
  tick: { tps: number; mspt: number; online: number } | null
  serverSide: 'not_reported' | 'reported'
  detail: Record<string, unknown>
}

/** A signal: what it is about, when it was raised, and whether and by whom it was closed. */
export interface SignalView {
  id: number
  kind: string
  serverId: string | null
  joinId: string | null
  at: string
  detail: Record<string, unknown>
  closedAt: string | null
  closedBy: string | null
}

/**
 * One join with what explains it: the start its wake asked for, step by step, the signals raised
 * on it, and how many times its player joined that server in the days joins are kept.
 */
export interface JoinDetailView {
  join: JoinView
  wake: {
    id: string
    kind: string
    status: string
    createdAt: string
    finishedAt: string | null
    steps: { step: string; at: string }[]
  } | null
  signals: SignalView[]
  joinsOnServer: number
}

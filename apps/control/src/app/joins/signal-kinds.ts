// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The signals judged from joins alone, each kind a pure function of the joins read, the `SIGNALS`
 * setting and the time: a slow join, one that left while it loaded, a short stay, a player who
 * pinged again and didn't come back, a join or a look at a watched address, a crowd on one server,
 * an early kick, and a slow tick. A kind whose key the setting leaves out raises nothing. Each
 * signal's key says what it is about, so it is raised once.
 *
 * Not for the kinds that read other tables (wakes, the platform's hour, boot reports): those are
 * `signals.ts`'s.
 */
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { SignalKind, SignalsConfig } from '@blockly/contracts/join-records'

/** A join as the signals read it, with its server's name and whether Cubepals runs it. */
export interface JoinRow {
  id: string
  kind: 'join' | 'look'
  serverId: string | null
  serverName: string | null
  /** The server is one of Cubepals' own, as `ourServers` names them. */
  ours: boolean
  address: string
  playerName: string | null
  playerUuid: string | null
  path: string | null
  connectedAt: Date
  handedAt: Date | null
  loginAt: Date | null
  inWorldAt: Date | null
  leftAt: Date | null
  leftReason: string | null
  pingedAfterAt: Date | null
  tick: { tps: number; mspt: number; online: number } | null
  serverSide: string
  /** How the wake it asked for found the server, where it asked for one. */
  wake: 'memory' | 'stopped' | 'atRest' | null
}

/** A signal to raise: once per `key`. */
export interface Raised {
  kind: SignalKind
  key: string
  serverId: string | null
  joinId: string | null
  at: Date
  detail: Record<string, unknown>
}

/** Whether an address's first label is one the setting watches. */
export const watched = (config: SignalsConfig, address: string): boolean =>
  (config.watchedAddresses ?? []).includes(address.split('.')[0] ?? '')

const seconds = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 100) / 10

/** What every signal on a join says: whose server, who, and through which address. */
const about = (row: JoinRow) => ({
  server: row.serverName,
  player: row.playerName,
  address: row.address,
})

const raise = (kind: SignalKind, row: JoinRow, which: string, at: Date, extra: Record<string, unknown>) => ({
  kind,
  key: `${kind}:${row.id}${which === '' ? '' : `:${which}`}`,
  serverId: row.serverId,
  joinId: row.id,
  at,
  detail: { ...about(row), ...extra },
})

/**
 * From login to in the world (or to now, while it is still waiting), past its limit; Cubepals' own
 * servers' where set. A join gone before the world is `left_while_loading`'s, not this.
 */
function slowLogin(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  const slow = config.slowJoin
  if (slow === undefined) return []
  return rows.flatMap((row) => {
    const limit = row.ours ? (slow.loginToWorldOursS ?? slow.loginToWorldS) : slow.loginToWorldS
    if (limit === undefined || row.loginAt === null) return []
    if (row.inWorldAt === null && row.leftAt !== null) return []
    const figure = seconds(row.loginAt, row.inWorldAt ?? now)
    return figure > limit ? [raise('slow_join', row, 'login', now, { figure, limit })] : []
  })
}

/** From connecting to in the world, past the limit for how its wake found the server. */
function slowConnect(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  const limits = config.slowJoin?.connectToWorldS
  if (limits === undefined) return []
  return rows.flatMap((row) => {
    const limit = row.wake === null ? undefined : limits[row.wake]
    if (limit === undefined || row.inWorldAt === null) return []
    const figure = seconds(row.connectedAt, row.inWorldAt)
    return figure > limit ? [raise('slow_join', row, 'connect', now, { figure, limit, wake: row.wake })] : []
  })
}

/** Handed to the server and gone before the world; or gave up in the waiting room. */
function leftWhileLoading(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  if (config.leftWhileLoading === undefined) return []
  return rows.flatMap((row) => {
    const reported = row.serverSide === 'reported' && row.handedAt !== null && row.inWorldAt === null
    const gaveUp = row.path === 'held' && row.leftReason === 'gave_up_waiting'
    if (row.leftAt === null || !(reported || gaveUp)) return []
    const figure = seconds(row.connectedAt, row.leftAt)
    return [raise('left_while_loading', row, '', now, { figure, why: gaveUp ? 'gave_up_waiting' : 'left' })]
  })
}

/** In the world, then gone of their own accord within moments. */
function shortStay(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  const limit = config.shortStay?.underS
  if (limit === undefined) return []
  return rows.flatMap((row) => {
    if (row.inWorldAt === null || row.leftAt === null || row.leftReason !== 'disconnected') return []
    const figure = seconds(row.inWorldAt, row.leftAt)
    return figure < limit ? [raise('short_stay', row, '', now, { figure, limit })] : []
  })
}

/** Pinged the server again after leaving, and didn't join it again in time. */
function lookedBack(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  const looked = config.lookedBack
  if (looked === undefined) return []
  return rows.flatMap((row) => {
    if (row.kind !== 'join' || row.pingedAfterAt === null || row.leftAt === null) return []
    const after = seconds(row.leftAt, row.pingedAfterAt)
    if (looked.pingWithinS !== undefined && after > looked.pingWithinS) return []
    const waited = (looked.noRejoinS ?? 0) * SECOND_MS
    const until = row.leftAt.getTime() + waited
    if (now.getTime() < until) return []
    const back = rows.some(
      (other) =>
        other.kind === 'join' &&
        other.id !== row.id &&
        other.serverId === row.serverId &&
        other.playerUuid !== null &&
        other.playerUuid === row.playerUuid &&
        other.connectedAt > (row.leftAt ?? now) &&
        other.connectedAt.getTime() <= until,
    )
    return back ? [] : [raise('looked_back', row, '', now, { figure: after, limit: looked.pingWithinS })]
  })
}

/** A join through a watched address. */
function watchedAddress(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  if (config.watchedAddress === undefined) return []
  return rows.flatMap((row) =>
    row.kind === 'join' && watched(config, row.address) ? [raise('watched_address', row, '', now, {})] : [],
  )
}

/**
 * Looks at watched addresses: each one, with `watchedEveryOne`, or else one signal for each address
 * and each `digestMinutes` that had any, raised once that stretch is over.
 */
function lookNoJoin(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  const look = config.lookNoJoin
  if (look === undefined) return []
  const looks = rows.filter((row) => row.kind === 'look' && watched(config, row.address))
  if (look.watchedEveryOne === true || look.digestMinutes === undefined)
    return looks.map((row) => raise('look_no_join', row, '', now, {}))
  const stretch = look.digestMinutes * MINUTE_MS
  const digests = new Map<
    string,
    { address: string; serverId: string | null; server: string | null; count: number }
  >()
  for (const row of looks) {
    const bucket = Math.floor(row.connectedAt.getTime() / stretch)
    if ((bucket + 1) * stretch > now.getTime()) continue
    const key = `look_no_join:${row.address}:${bucket * stretch}`
    const digest = digests.get(key) ?? {
      address: row.address,
      serverId: row.serverId,
      server: row.serverName,
      count: 0,
    }
    digest.count++
    digests.set(key, digest)
  }
  return [...digests].map(([key, digest]) => ({
    kind: 'look_no_join' as const,
    key,
    serverId: digest.serverId,
    joinId: null,
    at: now,
    detail: {
      server: digest.server,
      address: digest.address,
      figure: digest.count,
      minutes: look.digestMinutes,
    },
  }))
}

/** Many players joining one server within ten minutes. */
function crowd(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  const limits = config.crowd
  if (limits === undefined) return []
  const stretch = 10 * MINUTE_MS
  const since = now.getTime() - stretch
  const players = new Map<string, { row: JoinRow; uuids: Set<string> }>()
  for (const row of rows) {
    if (row.kind !== 'join' || row.serverId === null || row.playerUuid === null) continue
    if (row.connectedAt.getTime() <= since) continue
    const seen = players.get(row.serverId) ?? { row, uuids: new Set<string>() }
    seen.uuids.add(row.playerUuid)
    players.set(row.serverId, seen)
  }
  return [...players.values()].flatMap(({ row, uuids }) => {
    const limit = row.ours ? (limits.oursPlayersIn10Min ?? limits.playersIn10Min) : limits.playersIn10Min
    if (limit === undefined || uuids.size < limit) return []
    return [
      {
        kind: 'crowd' as const,
        key: `crowd:${row.serverId}:${Math.floor(now.getTime() / stretch) * stretch}`,
        serverId: row.serverId,
        joinId: null,
        at: now,
        detail: { server: row.serverName, address: row.address, figure: uuids.size, limit },
      },
    ]
  })
}

/** Kicked, timed out or thrown off soon after coming into the world. */
function kickedEarly(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  const limit = config.kickedEarly?.withinS
  if (limit === undefined) return []
  const early = ['kicked', 'timed_out', 'erroneous_state']
  return rows.flatMap((row) => {
    if (row.inWorldAt === null || row.leftAt === null || !early.includes(row.leftReason ?? '')) return []
    const figure = seconds(row.inWorldAt, row.leftAt)
    return figure <= limit
      ? [raise('kicked_early', row, '', now, { figure, limit, why: row.leftReason })]
      : []
  })
}

/** The server ticking slowly as the player came in. */
function slowTick(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  const limit = config.slowTick?.msptOver
  if (limit === undefined) return []
  return rows.flatMap((row) =>
    row.tick !== null && row.tick.mspt > limit
      ? [raise('slow_tick', row, '', now, { figure: row.tick.mspt, limit })]
      : [],
  )
}

/** Every signal the joins raise under `config` at `now`. */
export function fromJoins(config: SignalsConfig, rows: readonly JoinRow[], now: Date): Raised[] {
  return [
    slowLogin,
    slowConnect,
    leftWhileLoading,
    shortStay,
    lookedBack,
    watchedAddress,
    lookNoJoin,
    crowd,
    kickedEarly,
    slowTick,
  ].flatMap((kind) => kind(config, rows, now))
}

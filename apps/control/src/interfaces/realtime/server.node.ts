// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { MINUTE_MS } from '@blockly/contracts/durations'
import { type RealtimeMap, realtimeContract } from '@blockly/contracts/realtime'
import {
  CloseCode,
  type ConnectRequest,
  createServer,
  refuse,
  type ServerPeer,
  TransportError,
} from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { listenWebSocket } from 'transport-io/websocket-node-transport'
import type { ConsoleFeed } from '../../app/console/feed.ts'
import { observeRealtime, realtimeConnected } from '../../app/platform/telemetry.ts'
import type { DomainEvent, EventBus } from '../../app/ports/events.ts'
import type { RealtimeTickets, TicketHolder } from '../../app/ports/tickets.ts'
import { tuning } from '../../app/tuning.ts'
import { originAllowed } from '../http/origins.ts'

/** Each session is its ticket's: the account, and the sign-in session that asked for it. */
type Peer = TicketHolder

export interface RealtimeOptions {
  listen: { host: string; port: number }
  fallbackListen: { host: string; port: number }
  tls: { cert: string; privKey: string }
  allowedOrigins: readonly string[]
  events: EventBus
  tickets: RealtimeTickets
  console: ConsoleFeed
  /** Who is on a server now: presence events carry only the count. */
  presence: (serverId: string) => Promise<{ uuid: string; name: string }[]>
  /** How often an open session is checked again: RECHECK_MS unless a test says otherwise. */
  recheckMs?: number
}

const userRoom = (userId: string) => `user:${userId}`
const consoleRoom = (serverId: string) => `console:${serverId}`

/** How many earlier lines a console gets when it opens. */
const BACKFILL = 200

/**
 * How often an open session's sign-in, and each console it follows, is checked again. A session
 * whose sign-in has ended is closed; a console its account may no longer watch is left.
 */
const RECHECK_MS = MINUTE_MS

/** While a server is in one of these, its output is worth following. */
const TAILED = new Set(['provisioning', 'starting', 'running', 'stopping'])
/**
 * Steps in which a workload has just been started and prints as it boots. No status change marks
 * them on a new server's first start, or on a replaced one's, so the step itself opens the tail.
 */
const BOOTING = new Set(['booting', 'starting', 'loading_world'])

/**
 * Ends a handler's work. transport-io neither awaits nor catches what a handler returns, and an
 * unhandled rejection ends the process, so every async handler settles here. A peer that left
 * while its handler waited is routine; anything else is said, and the session carries on.
 */
const settle = (what: string) => (error: unknown) => {
  if (error instanceof TransportError && error.code === 'WT_SESSION_CLOSED') return
  console.error(`realtime: ${what} failed`, error)
}

/** Counts the browsers connected, and with the consoles followed, tells the monitor of both. */
function countBrowsers(tails: Map<string, AbortController>) {
  let open = 0
  observeRealtime(() => ({ browsers: open, tails: tails.size }))
  return { opened: () => void open++, closed: () => void open-- }
}

/**
 * Lets in a browser from Cubepals' own pages with a ticket that verifies. Each answer is timed and
 * counted by the transport it came over, and why it was refused if it was.
 */
const authorizer =
  (options: Pick<RealtimeOptions, 'allowedOrigins' | 'tickets'>, transport: 'webtransport' | 'websocket') =>
  async ({ query, headers }: ConnectRequest) => {
    const began = performance.now()
    const answered = <T>(outcome: string, answer: T): T => {
      realtimeConnected(transport, outcome, performance.now() - began)
      return answer
    }
    if (!originAllowed(headers.origin, options.allowedOrigins)) return answered('origin', refuse('origin'))
    const holder = await options.tickets.verify(query.get('ticket') ?? '')
    return holder === null ? answered('ticket', refuse('ticket')) : answered('accepted', holder)
  }

/**
 * The consoles one session follows: each `watch` is let in while the session's sign-in stands,
 * within the account's and the connection's limits (`AbuseLimits`), and only to a console the
 * account may watch; it is sent what the server printed before. Every `recheckMs` the sign-in and
 * each console are checked again. Returns what stops the rechecks, for when the session closes.
 */
function followConsoles(
  peer: ServerPeer<RealtimeMap, Peer>,
  deps: {
    feed: ConsoleFeed
    recheckMs: number
    startTail: (serverId: string) => Promise<void>
    stopTailIfUnwatched: (serverId: string) => void
  },
): () => void {
  const { feed } = deps
  const { userId } = peer.data
  /** The consoles this session follows, or is being let into: what counts against its limit. */
  const following = new Set<string>()
  /** The consoles whose room this session has joined. */
  const open = new Set<string>()

  /** Whether the session's sign-in still stands; when it doesn't, the session is closed. */
  const stillSignedIn = async () => {
    if (await feed.stillSignedIn(peer.data)) return true
    peer.close(CloseCode.WT_UNAUTHORIZED, 'signed out')
    return false
  }
  /**
   * Whether a watch may open its console now: `wait` while the account has opened its share of
   * consoles this minute, `closed` once the sign-in has ended, `barred` for a console the account
   * may not watch.
   */
  const admission = async (serverId: string) => {
    if (!(await feed.mayOpen(userId))) return 'wait'
    if (!(await stillSignedIn())) return 'closed'
    return (await feed.canWatch(userId, serverId)) ? 'open' : 'barred'
  }

  /**
   * Each console's latest watch or unwatch. A watch still being let in when another watch or an
   * unwatch of the same console arrives yields to it, so a joined room is always one `following` holds.
   */
  const turns = new Map<string, number>()
  const nextTurn = (serverId: string) => {
    const turn = (turns.get(serverId) ?? 0) + 1
    turns.set(serverId, turn)
    return turn
  }

  const watch = async (serverId: string) => {
    if (!following.has(serverId) && following.size >= tuning().abuse.consolesPerConnection) return
    following.add(serverId)
    const turn = nextTurn(serverId)
    const current = () => turns.get(serverId) === turn
    // A watch that doesn't open its console gives its place back; one already open stays open.
    const giveUp = async () => {
      if (current() && !open.has(serverId)) await unwatch(serverId)
    }
    try {
      const answer = await admission(serverId)
      if (answer === 'wait') return await giveUp()
      if (answer === 'closed' || !current()) return
      if (answer === 'barred') return await unwatch(serverId)
      await openConsole(serverId, current)
    } catch (error) {
      await giveUp()
      throw error
    }
  }
  /**
   * Joins a console let in and sends it what came before, while its watch is still the latest. An
   * unwatch that came while it was joining leaves again; a newer watch goes on alone.
   */
  const openConsole = async (serverId: string, current: () => boolean) => {
    await peer.join(consoleRoom(serverId))
    if (!current()) {
      if (following.has(serverId)) return
      await peer.leave(consoleRoom(serverId))
      deps.stopTailIfUnwatched(serverId)
      return
    }
    open.add(serverId)
    void deps.startTail(serverId)
    // What came before, to this watcher alone. A line that also arrives live is dropped by
    // the page, which knows each line by its time and text.
    const lines = await feed.recent(serverId, BACKFILL)
    if (!current()) return
    peer.emit('consoleHistory', {
      serverId,
      lines: lines.map((l) => ({ at: l.at.toISOString(), text: l.text, level: l.level })),
    })
  }
  const unwatch = async (serverId: string) => {
    nextTurn(serverId)
    following.delete(serverId)
    open.delete(serverId)
    await peer.leave(consoleRoom(serverId))
    deps.stopTailIfUnwatched(serverId)
  }
  // An admin who stops being one keeps only the consoles of servers they own.
  const recheck = async () => {
    if (!(await stillSignedIn())) return
    for (const serverId of [...following])
      if (!(await feed.canWatch(userId, serverId))) await unwatch(serverId)
  }

  peer.on('watch', ({ serverId }) => void watch(serverId).catch(settle('a watch')))
  peer.on('unwatch', ({ serverId }) => void unwatch(serverId).catch(settle('an unwatch')))
  const rechecks = setInterval(() => void recheck().catch(settle('a recheck')), deps.recheckMs)
  return () => clearInterval(rechecks)
}

/**
 * The realtime role: exactly one per deployment (Transport.io rooms live in one process). It
 * turns domain events into hints for each person's browser and streams console output to
 * whoever is watching a server.
 */
export async function startRealtime(options: RealtimeOptions): Promise<{ stop(): Promise<void> }> {
  const server = createServer<RealtimeMap, Peer>({ contract: realtimeContract })
  const tails = new Map<string, AbortController>()
  const browsers = countBrowsers(tails)

  const listener = await listenHttp3<Peer>({
    ...options.listen,
    ...options.tls,
    path: '/',
    authorize: authorizer(options, 'webtransport'),
  })
  const fallback = await listenWebSocket<Peer>({
    ...options.fallbackListen,
    path: '/transport-io',
    authorize: authorizer(options, 'websocket'),
  })

  const startTail = async (serverId: string) => {
    if (tails.has(serverId) || server.memberCount(consoleRoom(serverId)) === 0) return
    const controller = new AbortController()
    tails.set(serverId, controller)
    try {
      for await (const line of options.console.tail(serverId, controller.signal)) {
        void server
          .to(consoleRoom(serverId))
          .emit('consoleLine', { serverId, at: line.at.toISOString(), text: line.text, level: line.level })
      }
    } catch {
      // The workload went away; its next start re-opens the tail for anyone still watching.
    } finally {
      if (tails.get(serverId) === controller) tails.delete(serverId)
    }
  }

  const endTail = (serverId: string) => {
    tails.get(serverId)?.abort()
    tails.delete(serverId)
  }

  const stopTailIfUnwatched = (serverId: string) => {
    if (server.memberCount(consoleRoom(serverId)) > 0) return
    endTail(serverId)
  }

  server.onSession((peer: ServerPeer<RealtimeMap, Peer>) => {
    browsers.opened()
    peer.join(userRoom(peer.data.userId)).catch(settle('joining a person to their room'))
    const stopFollowing = followConsoles(peer, {
      feed: options.console,
      recheckMs: options.recheckMs ?? RECHECK_MS,
      startTail,
      stopTailIfUnwatched,
    })
    void peer.closed.then(() => {
      stopFollowing()
      browsers.closed()
      for (const serverId of tails.keys()) stopTailIfUnwatched(serverId)
    })
  })

  const unsubscribe = await options.events.subscribe((event) => {
    forward(event)
    if (event.type === 'operation_progress' && event.step !== null && BOOTING.has(event.step))
      void startTail(event.serverId)
    if (event.type !== 'server_changed') return
    // A tail follows one workload, and not every provider's tail ends with it. Leaving these
    // statuses can mean the workload is gone or replaced (restore, relocate, update).
    if (TAILED.has(event.status)) void startTail(event.serverId)
    else endTail(event.serverId)
  })

  function forward(event: DomainEvent) {
    const to = server.to(userRoom(event.ownerId))
    switch (event.type) {
      case 'server_changed':
        void to.emit('serverChanged', {
          serverId: event.serverId,
          status: event.status as RealtimeMap['serverChanged']['payload']['status'],
          version: event.version,
        })
        return
      case 'operation_progress':
        void to.emit('operationProgress', {
          serverId: event.serverId,
          operationId: event.operationId,
          kind: event.kind as RealtimeMap['operationProgress']['payload']['kind'],
          step: event.step as RealtimeMap['operationProgress']['payload']['step'],
          status: event.status,
        })
        return
      case 'access_changed':
        void to.emit('accessChanged', { serverId: event.serverId, version: event.version })
        return
      case 'backup_changed':
        void to.emit('backupChanged', { serverId: event.serverId })
        return
      case 'session_cap':
        void to.emit('sessionCap', {
          serverId: event.serverId,
          minutes: event.minutes,
          minutesLeft: event.minutesLeft,
        })
        return
      case 'listing_changed':
        void to.emit('listingChanged', { serverId: event.serverId })
        return
      case 'presence':
        void options
          .presence(event.serverId)
          .then((players) => to.emit('presence', { serverId: event.serverId, online: event.online, players }))
          .catch(() => undefined)
        return
    }
  }

  // Resolves once the event table is built and the accept loop runs; the fallback needs both.
  await server.listen(listener)
  server.withFallback(fallback)

  return {
    async stop() {
      await unsubscribe()
      for (const controller of tails.values()) controller.abort()
      listener.stop()
      fallback.stop()
    },
  }
}

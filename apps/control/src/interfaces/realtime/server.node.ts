// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type RealtimeMap, realtimeContract } from '@blockly/contracts/realtime'
import { type ConnectRequest, createServer, refuse, type ServerPeer } from 'transport-io'
import { listenHttp3 } from 'transport-io/node-transport'
import { listenWebSocket } from 'transport-io/websocket-node-transport'
import type { ConsoleFeed } from '../../app/console/feed.ts'
import type { DomainEvent, EventBus } from '../../app/ports/events.ts'
import type { RealtimeTickets } from '../../app/ports/tickets.ts'
import { originAllowed } from '../http/origins.ts'

interface Peer {
  userId: string
}

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
}

const userRoom = (userId: string) => `user:${userId}`
const consoleRoom = (serverId: string) => `console:${serverId}`

/** How many earlier lines a console gets when it opens. */
const BACKFILL = 200

/** While a server is in one of these, its output is worth following. */
const TAILED = new Set(['provisioning', 'starting', 'running', 'stopping'])
/**
 * Steps in which a workload has just been started and prints as it boots. No status change marks
 * them on a new server's first start, or on a replaced one's, so the step itself opens the tail.
 */
const BOOTING = new Set(['booting', 'starting', 'loading_world'])

/**
 * The realtime role: exactly one per deployment (Transport.io rooms live in one process). It
 * turns domain events into hints for each person's browser and streams console output to
 * whoever is watching a server.
 */
export async function startRealtime(options: RealtimeOptions): Promise<{ stop(): Promise<void> }> {
  const server = createServer<RealtimeMap, Peer>({ contract: realtimeContract })
  const tails = new Map<string, AbortController>()

  const authorize = async ({ query, headers }: ConnectRequest) => {
    if (!originAllowed(headers.origin, options.allowedOrigins)) return refuse('origin')
    const userId = await options.tickets.verify(query.get('ticket') ?? '')
    return userId === null ? refuse('ticket') : { userId }
  }

  const listener = await listenHttp3<Peer>({ ...options.listen, ...options.tls, path: '/', authorize })
  const fallback = await listenWebSocket<Peer>({
    ...options.fallbackListen,
    path: '/transport-io',
    authorize,
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
    void peer.join(userRoom(peer.data.userId))
    peer.on('watch', async ({ serverId }) => {
      if (!(await options.console.canWatch(peer.data.userId, serverId))) return
      await peer.join(consoleRoom(serverId))
      void startTail(serverId)
      // What came before, to this watcher alone. A line that also arrives live is dropped by
      // the page, which knows each line by its time and text.
      const lines = await options.console.recent(serverId, BACKFILL)
      peer.emit('consoleHistory', {
        serverId,
        lines: lines.map((l) => ({ at: l.at.toISOString(), text: l.text, level: l.level })),
      })
    })
    peer.on('unwatch', async ({ serverId }) => {
      await peer.leave(consoleRoom(serverId))
      stopTailIfUnwatched(serverId)
    })
    void peer.closed.then(() => {
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

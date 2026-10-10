// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { type RealtimeMap, realtimeContract } from '@blockly/contracts/realtime'
import { useQueryClient } from '@tanstack/react-query'
import { TransportDevtools } from '@transport-io/devtools/react'
import { createHooks, TransportProvider } from '@transport-io/react'
import { type ReactNode, useEffect, useState } from 'react'
import { withFallback } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { connectWebSocket } from 'transport-io/websocket-transport'
import { useTRPC, useTRPCClient } from './api'

export const realtime = createHooks<RealtimeMap>()

const withTicket = (url: string, ticket: string) => {
  const target = new URL(url)
  target.searchParams.set('ticket', ticket)
  return target.href
}

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))

/**
 * Hints from the control plane. Every event invalidates the queries it concerns, and every new
 * session refetches everything: the truth always comes from tRPC.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const trpcClient = useTRPCClient()
  const [client] = useState(() =>
    withFallback<RealtimeMap>({
      contract: realtimeContract,
      reconnect: { minMs: 1_000, maxMs: 30_000 },
      connect: async () => {
        const info = await trpcClient.realtime.connectInfo.query()
        return connectBrowser({
          url: withTicket(info.url, info.ticket),
          ...(info.certificateSha256 ? { certificateHash: hexBytes(info.certificateSha256) } : {}),
        })
      },
      fallback: async () => {
        const info = await trpcClient.realtime.connectInfo.query()
        return connectWebSocket({ url: withTicket(info.fallbackUrl, info.ticket) })
      },
    }),
  )
  return (
    <TransportProvider client={client}>
      <Invalidation />
      {/* transport-io's own panel: every frame, the connection, and why it's on the fallback. It
          renders nothing outside a development build, and a production one has none of it. */}
      <TransportDevtools client={client} />
      {children}
    </TransportProvider>
  )
}

function Invalidation() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const connection = realtime.useConnection()

  const server = (serverId: string) => {
    void queries.invalidateQueries({ queryKey: trpc.servers.get.queryKey({ serverId }) })
    void queries.invalidateQueries({ queryKey: trpc.servers.list.queryKey() })
  }
  // An apply that finishes, or goes back, moves what the history marks as running.
  const configuration = (serverId: string) => {
    void queries.invalidateQueries({ queryKey: trpc.servers.revisions.queryKey({ serverId }) })
    void queries.invalidateQueries({ queryKey: trpc.servers.settingsOptions.queryKey({ serverId }) })
    void queries.invalidateQueries({ queryKey: trpc.mods.list.queryKey({ serverId }) })
    void queries.invalidateQueries({ queryKey: trpc.worlds.list.queryKey({ serverId }) })
    void queries.invalidateQueries({ queryKey: trpc.worlds.freshStart.queryKey({ serverId }) })
  }
  realtime.useEvent('serverChanged', ({ serverId, version }) => {
    // Versions order what a server went through (§4): a hint the page already has, because its
    // own change or a new session's refetch overtook it, doesn't fetch the server again.
    const shown = queries.getQueryData(trpc.servers.get.queryKey({ serverId }))
    if (shown === undefined || shown.version < version)
      void queries.invalidateQueries({ queryKey: trpc.servers.get.queryKey({ serverId }) })
    void queries.invalidateQueries({ queryKey: trpc.servers.list.queryKey() })
    configuration(serverId)
  })
  realtime.useEvent('operationProgress', ({ serverId, status }) => {
    server(serverId)
    if (status !== 'running') configuration(serverId)
  })
  // Whoever just joined is someone the Players page can now offer to name.
  realtime.useEvent('presence', ({ serverId }) => {
    server(serverId)
    void queries.invalidateQueries({ queryKey: trpc.access.get.queryKey({ serverId }) })
    // Someone joined or left, or what waited for them was done: a player's open page reads again.
    void queries.invalidateQueries({ queryKey: trpc.players.get.pathKey() })
  })
  // Its session is ending or has ended: the page reads why from the server itself.
  realtime.useEvent('sessionCap', ({ serverId }) => server(serverId))
  realtime.useEvent('backupChanged', ({ serverId }) => {
    void queries.invalidateQueries({ queryKey: trpc.backups.list.queryKey({ serverId }) })
    void queries.invalidateQueries({ queryKey: trpc.worlds.list.queryKey({ serverId }) })
  })
  realtime.useEvent('accessChanged', ({ serverId }) => {
    void queries.invalidateQueries({ queryKey: trpc.access.get.queryKey({ serverId }) })
  })
  realtime.useEvent('listingChanged', ({ serverId }) => {
    void queries.invalidateQueries({ queryKey: trpc.listings.own.queryKey({ serverId }) })
  })

  // A reconnect is a new session: whatever happened while away is only in the database.
  const sessionId = connection.status === 'connected' ? connection.sessionId : null
  useEffect(() => {
    if (sessionId !== null) void queries.invalidateQueries()
  }, [sessionId, queries])

  // Without a session there are no hints, so the page asks for itself until one comes back
  // (correctness never depends on realtime). Only what is on screen refetches.
  useEffect(() => {
    if (sessionId !== null) return
    const poll = setInterval(() => void queries.invalidateQueries({ type: 'active' }), DISCONNECTED_POLL_MS)
    return () => clearInterval(poll)
  }, [sessionId, queries])

  return null
}

/** How often a page refetches what it shows while realtime is away. */
const DISCONNECTED_POLL_MS = 10_000

/**
 * Watches a server's console for as long as the component is on the page: what it printed
 * before arrives as `consoleHistory`, then each new line as `consoleLine`. Watching belongs to a
 * session, so a reconnect watches again.
 */
export function useWatchConsole(serverId: string): void {
  const client = realtime.useClient()
  const connection = realtime.useConnection()
  const sessionId = connection.status === 'connected' ? connection.sessionId : null
  useEffect(() => {
    if (sessionId === null) return
    client.emit('watch', { serverId, topic: 'console' })
    return () => client.emit('unwatch', { serverId, topic: 'console' })
  }, [client, sessionId, serverId])
}

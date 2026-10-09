import { defineContract, fromClient, fromServer, type MapOf, reliable } from 'transport-io'
import { z } from 'zod'
import { OPERATION_KINDS, OPERATION_STEPS, SERVER_STATUSES } from './server.ts'

const serverId = z.uuid()
const player = z.object({ uuid: z.string(), name: z.string() })
const line = {
  at: z.string(),
  text: z.string(),
  /** `setup` is the image getting the server ready, before Minecraft says anything. */
  level: z.enum(['info', 'warn', 'error', 'chat', 'setup']),
}

/**
 * Every server event is a hint: the web app refetches the truth over tRPC when one arrives, and
 * on every new session. Nothing uses `call` or `stream`, so the WebSocket fallback behaves the
 * same as WebTransport.
 */
export const realtimeContract = defineContract({
  serverChanged: fromServer(
    reliable(z.object({ serverId, status: z.enum(SERVER_STATUSES), version: z.number().int() })),
  ),
  operationProgress: fromServer(
    reliable(
      z.object({
        serverId,
        operationId: z.uuid(),
        kind: z.enum(OPERATION_KINDS),
        step: z.enum(OPERATION_STEPS).nullable(),
        status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
      }),
    ),
  ),
  presence: fromServer(reliable(z.object({ serverId, online: z.number().int(), players: z.array(player) }))),
  accessChanged: fromServer(reliable(z.object({ serverId, version: z.number().int() }))),
  backupChanged: fromServer(reliable(z.object({ serverId }))),
  /** The plan's session cap: `minutesLeft` to go, or 0 when the server is being stopped. */
  sessionCap: fromServer(
    reliable(z.object({ serverId, minutes: z.number().int(), minutesLeft: z.number().int() })),
  ),
  listingChanged: fromServer(reliable(z.object({ serverId }))),
  consoleLine: fromServer(reliable(z.object({ serverId, ...line }))),
  /** What the server printed before someone started watching, sent to them alone (§13). */
  consoleHistory: fromServer(reliable(z.object({ serverId, lines: z.array(z.object(line)) }))),
  watch: fromClient(reliable(z.object({ serverId, topic: z.enum(['console']) }))),
  unwatch: fromClient(reliable(z.object({ serverId, topic: z.enum(['console']) }))),
})

export interface RealtimeMap extends MapOf<typeof realtimeContract> {}

/** What the web app needs to open a realtime session, fetched over tRPC before every connect. */
export interface RealtimeConnectInfo {
  url: string
  /** Hex SHA-256 of the pinned certificate, when the deployment pins one. */
  certificateSha256: string | null
  /** The WebSocket fallback, for browsers without WebTransport. */
  fallbackUrl: string
  ticket: string
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Realtime asked as a browser asks it, over each of its two ways in: WebTransport (HTTP/3 over
 * UDP, on the realtime process's own TLS) and the WebSocket fallback (TCP, TLS at Fly's proxy).
 * Each is asked from no page of Cubepals' and with no ticket, so realtime must turn it away by
 * name (`REALTIME_REFUSALS`, apps/control/src/interfaces/realtime/server.node.ts). That refusal
 * is the answer wanted: it comes from realtime's own code, so an open port, a proxy with nothing
 * behind it, or a session that opens and then hears nothing all fail.
 *
 * Not a check of the certificate a browser will be shown: the realtime role renews its own (§13).
 * Without a pinned certificate's hash, the WebTransport binding checks the certificate against the
 * system's authorities, a path it calls experimental and says so on stdout once a process.
 *
 * Node only: the WebTransport binding is native, and loads only from a `*.node.ts` file.
 */
import { lookup } from 'node:dns/promises'
import { SECOND_MS } from '@blockly/contracts/durations'
import { REALTIME_FALLBACK_PATH, REALTIME_REFUSALS } from '@blockly/contracts/realtime'
import { quicheLoaded, WebTransport } from '@fails-components/webtransport'

export type Transport = 'webtransport' | 'websocket'

/** Each transport, as a person reads it. */
export const TRANSPORT_NAMES: Record<Transport, string> = {
  webtransport: 'WebTransport',
  websocket: 'WebSocket',
}

/** What one transport answered: whether realtime itself did, and in words. */
export interface RealtimeAnswer {
  transport: Transport
  up: boolean
  said: string
  /** The handshake's time, when there was one. */
  ms?: number
}

/** How long each step may take: the handshake, then realtime's refusal after it. As HQ's probe. */
const STEP_MS = 6 * SECOND_MS

/** Where a browser opens each transport on realtime's host: `rt.cubepals.com`, or a host:port. */
export const realtimeUrls = (host: string): Record<Transport, string> => ({
  webtransport: `https://${host}/`,
  websocket: `wss://${host}${REALTIME_FALLBACK_PATH}`,
})

const refusals: readonly string[] = Object.values(REALTIME_REFUSALS)
/**
 * A promise's value, or `late` once `ms` have passed. The timer holds the process until one of them
 * settles: a socket that fails without the event awaited would otherwise leave nothing running,
 * and Node ends a script whose top-level await can't settle (exit 13).
 */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
const say = (ms: number) => (ms < SECOND_MS ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`)

/** What a refusal, or its absence, says once the handshake is done. */
function heard(transport: Transport, reason: string | 'late', ms: number): RealtimeAnswer {
  if (refusals.includes(reason))
    return {
      transport,
      up: true,
      ms,
      said: `a handshake in ${say(ms)}, then refused by realtime ("${reason}")`,
    }
  if (reason === 'late')
    return { transport, up: false, ms, said: `a handshake in ${say(ms)}, then nothing for ${say(STEP_MS)}` }
  return {
    transport,
    up: false,
    ms,
    said: `a handshake in ${say(ms)}, then closed without realtime's refusal (${reason || 'no reason'})`,
  }
}

/** A WebTransport session opened, and how realtime closed it. */
async function overWebTransport(url: string, certificateHash?: Uint8Array): Promise<RealtimeAnswer> {
  // The binding throws out of its own callback, ending the process, for a name that doesn't
  // resolve; asked first, it is an answer like any other.
  const { hostname } = new URL(url)
  const address = await lookup(hostname).catch((error: NodeJS.ErrnoException) => error.code ?? error.message)
  if (typeof address === 'string')
    return { transport: 'webtransport', up: false, said: `no address for ${hostname} (${address})` }
  await quicheLoaded
  const began = performance.now()
  const session = new WebTransport(
    url,
    certificateHash ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: certificateHash }] } : {},
  )
  // Claimed before anything is awaited: a failed handshake rejects both, and an unclaimed
  // rejection ends the process.
  const closed = session.closed.then(
    (info) => info.reason ?? '',
    (error: Error) => error.message,
  )
  // Closing a session realtime already closed throws in the binding; what is left to end is ended.
  const end = () => {
    try {
      session.close()
    } catch {
      // Already closed.
    }
  }
  const ready = await within(
    session.ready.then(
      () => 'ready' as const,
      (error: Error) => error.message,
    ),
    STEP_MS,
  )
  if (ready !== 'ready') {
    end()
    const said = ready === 'late' ? `no handshake within ${say(STEP_MS)}` : `no handshake (${ready})`
    return { transport: 'webtransport', up: false, said }
  }
  const ms = performance.now() - began
  const answer = heard('webtransport', await within(closed, STEP_MS), ms)
  end()
  return answer
}

/** A WebSocket opened, and how realtime closed it. */
async function overWebSocket(url: string): Promise<RealtimeAnswer> {
  const began = performance.now()
  const socket = new WebSocket(url)
  let opened: number | undefined
  const closed = new Promise<string>((resolve) => {
    socket.addEventListener('open', () => {
      opened = performance.now() - began
    })
    // A connection that never opens may say so with `error` alone.
    socket.addEventListener('error', () => {
      if (opened === undefined) resolve('')
    })
    socket.addEventListener('close', (event) => resolve(event.reason))
  })
  const reason = await within(closed, STEP_MS)
  if (opened === undefined) {
    socket.close()
    const said =
      reason === 'late' ? `no handshake within ${say(STEP_MS)}` : 'no handshake (the connection closed)'
    return { transport: 'websocket', up: false, said }
  }
  const answer = heard('websocket', reason === 'late' ? await within(closed, STEP_MS) : reason, opened)
  socket.close()
  return answer
}

/**
 * Realtime asked over the transports given, at once. `certificateHash` pins WebTransport's
 * certificate, as a page is given one where realtime runs on a pinned certificate.
 */
export function askRealtime(
  urls: Partial<Record<Transport, string>>,
  options: { certificateHash?: Uint8Array } = {},
): Promise<RealtimeAnswer[]> {
  return Promise.all([
    ...(urls.webtransport ? [overWebTransport(urls.webtransport, options.certificateHash)] : []),
    ...(urls.websocket ? [overWebSocket(urls.websocket)] : []),
  ])
}

/** One line a person reads: "WebTransport: a handshake in 305 ms, then refused by realtime ("origin")". */
export const describeRealtime = (answer: RealtimeAnswer) =>
  `${TRANSPORT_NAMES[answer.transport]}: ${answer.said}`

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The headless client's way out (`join.ts`): a UDP forwarder on this machine's loopback that passes
 * the client's datagrams to the edge and the edge's replies back, and drops a datagram too large
 * for Fly's UDP before it leaves.
 *
 * Fly drops a datagram larger than its UDP path carries without an ICMP reply, so the client never
 * learns the path's MTU, and drops what the same socket sends after it. RakNet's client opens a
 * connection with requests padded to 1492 bytes, then 1200, then 576, so every attempt is lost on
 * its first request. Dropped here, as a path that answers with ICMP would have it, the large
 * requests never leave and the 1200-byte ones connect.
 *
 * Not for the client's own retries, or for what a test asks of the edge (`join.ts`).
 */

import { createSocket, type Socket } from 'node:dgram'

/** The IP and UDP headers a datagram's MTU counts and its payload leaves out. */
const HEADERS = { udp4: 20 + 8, udp6: 40 + 8 } as const

export interface Target {
  /** An address, not a name: a datagram's size is checked once, not a lookup per datagram. */
  host: string
  port: number
  family: keyof typeof HEADERS
}

export interface Forwarder {
  /** The loopback port the client sends to. */
  port: number
  close: () => void
}

/**
 * Forwards to `target` what reaches the returned loopback port, dropping a datagram larger than
 * `mtu`. One upstream socket per client port, so the far end sees every client as its own peer.
 * The client's side is IPv4, as bedrock-protocol's RakNet is; `target` may be IPv6, as a Fly
 * machine's private network is.
 */
export async function forwarder(target: Target, mtu: number): Promise<Forwarder> {
  const largest = mtu - HEADERS[target.family]
  const front = createSocket('udp4')
  const upstreams = new Map<number, Socket>()
  front.on('error', () => undefined)
  front.on('message', (message, from) => {
    if (message.length > largest) return
    let up = upstreams.get(from.port)
    if (up === undefined) {
      up = createSocket(target.family)
      up.on('error', () => undefined)
      up.on('message', (back) => front.send(back, from.port, from.address))
      upstreams.set(from.port, up)
    }
    up.send(message, target.port, target.host)
  })
  await new Promise<void>((resolve) => front.bind(0, '127.0.0.1', resolve))
  return {
    port: front.address().port,
    close() {
      for (const up of upstreams.values()) up.close()
      upstreams.clear()
      front.close()
    },
  }
}

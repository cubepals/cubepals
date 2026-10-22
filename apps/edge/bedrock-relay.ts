// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edge's Bedrock front door: the UDP socket Bedrock players reach on the edge's dedicated
 * address, in front of the Geyser the agent supervises (`bedrock.ts`). Geyser listens on loopback;
 * this hands it each player's datagrams and gives each player an upstream socket of their own, so
 * Geyser's replies find their way back. A player's first datagram goes to Geyser behind a PROXY v2
 * header naming their real address, which Geyser reads once per source (its Bedrock
 * `use-haproxy-protocol`), so its own limits, the logs and the address Floodgate hands the server
 * are the player's, not this relay's.
 *
 * - A ping is answered here, from the last pong Geyser gave, so a flood of them never reaches Geyser
 *   or costs it a socket. A pong is far larger than the ping that asks for it, so an address is
 *   answered only so many a second.
 * - A peer exists only once it opens a RakNet connection (the first packet a player sends); the
 *   address's new peers are rate limited, the peers held are capped, and a quiet one is dropped.
 *
 * Not for deciding who may join: Geyser signs players in, and the Java path (`front.ts`) limits them.
 */

import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { proxyHeader } from '../../packages/contracts/src/proxy-header.ts'
import { addressKey, Bucket, type Rate } from './limits.ts'

type Udp = Bun.udp.Socket<'buffer'>

export interface RelayOptions {
  /** Where players reach the relay: the address bound to `fly-global-services` in production. */
  bind: { hostname: string; port: number }
  /** Where Geyser listens, on this machine. */
  geyser: { hostname: string; port: number }
  /** How many pongs one address is sent. */
  pongs: Rate
  /** How many pongs are sent in all, whoever asks: a flood from many addresses is answered no faster. */
  totalPongs: Rate
  /** How many new connections one address may open. */
  opens: Rate
  /** How many players are held at most. */
  most: number
  /** How long a player may be quiet before they are dropped. */
  idleMs: number
  /** How long a pong from Geyser stands before it asks for another. */
  pongRefreshMs: number
  /** How often quiet players are looked for. */
  sweepMs?: number
}

/** RakNet's offline message id, in every ping, pong and connection request. */
const MAGIC = Uint8Array.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
])
const UNCONNECTED_PING = 0x01
const UNCONNECTED_PING_OPEN = 0x02
const UNCONNECTED_PONG = 0x1c
/** The packet a player opens a connection with. */
const OPEN_CONNECTION_REQUEST_1 = 0x05
/** Id, time, and the magic; the sender's guid follows. */
const PING_LENGTH = 1 + 8 + 16 + 8
const PONG_TIME_AT = 1

/**
 * A datagram sent to a port nobody listens on comes back as a refusal on the next read, which Bun
 * throws from the socket unless a handler takes it. Geyser's port is closed while it restarts, so
 * a relay without one would take the whole agent down with it.
 */
function ignoreRefusal(): void {}

const hasMagic = (packet: Uint8Array, at: number): boolean =>
  MAGIC.every((byte, i) => packet[at + i] === byte)

/** Whether `packet` is a RakNet ping, which a server list sends to learn what a server says of itself. */
export function isPing(packet: Uint8Array): boolean {
  return (
    packet.length >= PING_LENGTH &&
    (packet[0] === UNCONNECTED_PING || packet[0] === UNCONNECTED_PING_OPEN) &&
    hasMagic(packet, 9)
  )
}

/** Whether `packet` is a pong, as Geyser answers a ping. */
const isPong = (packet: Uint8Array): boolean => packet[0] === UNCONNECTED_PONG && hasMagic(packet, 17)

/** Whether `packet` is the first a connection sends: the only one that may make a player. */
const opens = (packet: Uint8Array): boolean => packet[0] === OPEN_CONNECTION_REQUEST_1 && hasMagic(packet, 1)

/** A pong for `ping`: the pong Geyser gave, with the time the ping carried, which the client matches by. */
export function pongFor(pong: Uint8Array, ping: Uint8Array): Uint8Array {
  const answer = pong.slice()
  answer.set(ping.subarray(PONG_TIME_AT, PONG_TIME_AT + 8), PONG_TIME_AT)
  return answer
}

interface Player {
  upstream: Udp
  lastAt: number
  /** Datagrams that came while the upstream socket was being made. */
  waiting: Uint8Array[] | null
}

export interface Relay {
  close: () => void
  /** How many players are held. */
  players: () => number
  /** Whether Geyser has answered a ping lately, which is whether it is taking players. */
  ready: () => boolean
}

/** Opens the relay's socket. */
export async function bedrockRelay(options: RelayOptions): Promise<Relay> {
  const { bind, geyser } = options
  const players = new Map<string, Player>()
  const pongAllowed = new Map<string, Bucket>()
  const openAllowed = new Map<string, Bucket>()
  const totalPongs = new Bucket(options.totalPongs, Date.now())
  let pong: Uint8Array | null = null
  let pongAt = 0

  const allowed = (buckets: Map<string, Bucket>, rate: Rate, address: string): boolean => {
    const key = addressKey(address)
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = new Bucket(rate, Date.now())
      buckets.set(key, bucket)
    }
    return bucket.take(Date.now())
  }

  /** Behind the header that says whose datagram it is: sent with a source's first, Geyser keeps it. */
  const toGeyser = (upstream: Udp, from: { address: string; port: number }, packet: Uint8Array): void => {
    const header = proxyHeader(from, { address: bind.hostname, port: bind.port }, true)
    const framed = new Uint8Array(header.length + packet.length)
    framed.set(header)
    framed.set(packet, header.length)
    upstream.send(framed, geyser.port, geyser.hostname)
  }

  const front: Udp = await Bun.udpSocket({
    hostname: bind.hostname,
    port: bind.port,
    socket: {
      error: ignoreRefusal,
      data(_socket, packet, port, address) {
        const key = `${address}:${port}`
        if (isPing(packet)) {
          // The total is taken last, so an address already refused doesn't spend it.
          if (pong !== null && allowed(pongAllowed, options.pongs, address) && totalPongs.take(Date.now()))
            front.send(pongFor(pong, packet), port, address)
          return
        }
        const known = players.get(key)
        if (known !== undefined) {
          known.lastAt = Date.now()
          if (known.waiting !== null) known.waiting.push(Uint8Array.from(packet))
          else known.upstream.send(packet, geyser.port, geyser.hostname)
          return
        }
        if (!opens(packet) || players.size >= options.most || !allowed(openAllowed, options.opens, address))
          return
        const player: Player = {
          upstream: null as unknown as Udp,
          lastAt: Date.now(),
          waiting: [Uint8Array.from(packet)],
        }
        players.set(key, player)
        void Bun.udpSocket({
          hostname: '127.0.0.1',
          socket: {
            error: ignoreRefusal,
            data(_upstream, back) {
              player.lastAt = Date.now()
              front.send(back, port, address)
            },
          },
        }).then((upstream) => {
          player.upstream = upstream
          const [first, ...rest] = player.waiting ?? []
          if (first !== undefined) toGeyser(upstream, { address, port }, first)
          for (const next of rest) upstream.send(next, geyser.port, geyser.hostname)
          player.waiting = null
        })
      },
    },
  })

  // Geyser's pong, asked for through a socket of the relay's own, since it answers only datagrams
  // that say whose they are.
  const probe: Udp = await Bun.udpSocket({
    hostname: '127.0.0.1',
    socket: {
      error: ignoreRefusal,
      data(_socket, packet) {
        if (!isPong(packet)) return
        pong = Uint8Array.from(packet)
        pongAt = Date.now()
      },
    },
  })
  const ask = () => {
    const ping = new Uint8Array(PING_LENGTH)
    ping[0] = UNCONNECTED_PING
    ping.set(MAGIC, 9)
    toGeyser(probe, { address: '127.0.0.1', port: probe.port }, ping)
  }
  ask()
  const asking = setInterval(ask, options.pongRefreshMs)

  const sweeping = setInterval(
    () => {
      const now = Date.now()
      for (const [key, player] of players) {
        if (now - player.lastAt < options.idleMs) continue
        player.upstream?.close()
        players.delete(key)
      }
      for (const buckets of [pongAllowed, openAllowed])
        for (const [key, bucket] of buckets) if (bucket.full(now)) buckets.delete(key)
    },
    options.sweepMs ?? 10 * SECOND_MS,
  )

  return {
    players: () => players.size,
    ready: () => pong !== null && Date.now() - pongAt < 3 * options.pongRefreshMs,
    close() {
      clearInterval(asking)
      clearInterval(sweeping)
      front.close()
      probe.close()
      for (const player of players.values()) player.upstream?.close()
      players.clear()
    },
  }
}

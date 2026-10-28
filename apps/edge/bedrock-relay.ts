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
 * - A peer exists only once it opens a RakNet connection (the first packet a player sends), and
 *   only while Geyser answers; the address's new peers are rate limited, and the peers held are
 *   capped per address and in all.
 * - Geyser forgets a source's header when the source goes quiet, and forgets every source when it
 *   starts over, and a datagram from a source it has forgotten is dropped. So the relay forgets a
 *   quiet player first, and every player when Geyser starts over (`forget`): a player who sends
 *   again is a new peer, whose first datagram carries the header again.
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
  /** How many players one address (an IPv6 one by its /64) may hold at once. */
  perAddress: number
  /** How many players are held at most. */
  most: number
  /**
   * How long a player may send nothing before they are forgotten: less than Geyser keeps a quiet
   * source's header, so the relay never holds a player whose header Geyser has let go.
   */
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
  /** When the player last sent: Geyser's replies don't count, as they don't keep its header. */
  lastAt: number
  /** The address it is counted under (`addressKey`). */
  address: string
  /** Datagrams that came while the upstream socket was being made. */
  waiting: Uint8Array[] | null
}

/** The players held, by source, and how many each address holds: at most `perAddress`. */
class Peers {
  readonly #bySource = new Map<string, Player>()
  readonly #perAddress = new Map<string, number>()
  readonly #most: number

  constructor(perAddress: number) {
    this.#most = perAddress
  }

  get size(): number {
    return this.#bySource.size
  }

  get(key: string): Player | undefined {
    return this.#bySource.get(key)
  }

  [Symbol.iterator](): MapIterator<[string, Player]> {
    return this.#bySource.entries()
  }

  /** Whether `address` may hold another player. */
  roomFor(address: string): boolean {
    return this.#of(addressKey(address)) < this.#most
  }

  #of(key: string): number {
    return this.#perAddress.get(key) ?? 0
  }

  add(key: string, player: Player): void {
    this.#bySource.set(key, player)
    this.#perAddress.set(player.address, this.#of(player.address) + 1)
  }

  drop(key: string, player: Player): void {
    player.upstream?.close()
    if (this.#bySource.get(key) !== player) return
    this.#bySource.delete(key)
    const left = this.#of(player.address) - 1
    if (left > 0) this.#perAddress.set(player.address, left)
    else this.#perAddress.delete(player.address)
  }

  clear(): void {
    for (const [key, player] of this.#bySource) this.drop(key, player)
  }
}

export interface Relay {
  close: () => void
  /** How many players are held. */
  players: () => number
  /** Whether Geyser has answered a ping lately, which is whether it is taking players. */
  ready: () => boolean
  /**
   * Lets every player and the last pong go, for a Geyser that has started over: it knows none of
   * them. The relay is ready again once the new Geyser answers.
   */
  forget: () => void
}

/**
 * Asks Geyser for its pong, through sockets of the relay's own, since it answers only datagrams
 * that say whose they are. Geyser reads that header once per source and takes what follows as the
 * game's own, so each ask comes from a new socket, with the header ahead of its only datagram: a
 * socket asking again would be unanswered after the first pong, and one asking a Geyser that has
 * started over would never be answered.
 */
function pongProbes(
  send: (upstream: Udp, from: { address: string; port: number }, packet: Uint8Array) => void,
  got: (pong: Uint8Array) => void,
  giveUpMs: number,
): { ask: () => void; close: () => void } {
  const open = new Set<Udp>()
  let closed = false
  let said = false
  return {
    ask() {
      const ping = new Uint8Array(PING_LENGTH)
      ping[0] = UNCONNECTED_PING
      ping.set(MAGIC, 9)
      void Bun.udpSocket({
        hostname: '127.0.0.1',
        socket: {
          error: ignoreRefusal,
          data(self, packet) {
            if (!isPong(packet)) return
            got(packet)
            open.delete(self)
            self.close()
          },
        },
      })
        .then((probe) => {
          if (closed) return probe.close()
          open.add(probe)
          send(probe, { address: '127.0.0.1', port: probe.port }, ping)
          // An ask nobody answers is let go before the next.
          setTimeout(() => {
            if (open.delete(probe)) probe.close()
          }, giveUpMs)
        })
        .catch((error: unknown) => {
          // No socket to ask with is a Geyser that isn't answering: the pong ages out and the relay
          // reads as not ready. It is said once, not at every ask, and never takes the agent down.
          if (said) return
          said = true
          console.error('[geyser] the relay could not ask Geyser for its pong; Bedrock reads as down', error)
        })
    },
    close() {
      closed = true
      for (const probe of open) probe.close()
      open.clear()
    },
  }
}

/** Opens the relay's socket. */
export async function bedrockRelay(options: RelayOptions): Promise<Relay> {
  const { bind, geyser } = options
  const players = new Peers(options.perAddress)
  const pongAllowed = new Map<string, Bucket>()
  const openAllowed = new Map<string, Bucket>()
  const totalPongs = new Bucket(options.totalPongs, Date.now())
  let pong: Uint8Array | null = null
  let pongAt = 0
  const ready = () => pong !== null && Date.now() - pongAt < 3 * options.pongRefreshMs

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

  /** Sends a known player's datagram on; false for a stranger, which may open a connection. */
  const passedOn = (key: string, packet: Uint8Array): boolean => {
    const known = players.get(key)
    if (known === undefined) return false
    // Quiet for that long, they are a stranger to Geyser too: what they send now starts over.
    if (Date.now() - known.lastAt >= options.idleMs) {
      players.drop(key, known)
      return false
    }
    known.lastAt = Date.now()
    if (known.waiting !== null) known.waiting.push(Uint8Array.from(packet))
    else known.upstream.send(packet, geyser.port, geyser.hostname)
    return true
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
        if (passedOn(key, packet)) return
        // While Geyser isn't answering, a header sent now would be lost and the player with it.
        if (!opens(packet) || !ready() || players.size >= options.most || !players.roomFor(address)) return
        if (!allowed(openAllowed, options.opens, address)) return
        const player: Player = {
          upstream: null as unknown as Udp,
          lastAt: Date.now(),
          address: addressKey(address),
          waiting: [Uint8Array.from(packet)],
        }
        players.add(key, player)
        void Bun.udpSocket({
          hostname: '127.0.0.1',
          socket: {
            error: ignoreRefusal,
            data(_upstream, back) {
              front.send(back, port, address)
            },
          },
        }).then((upstream) => {
          // Forgotten while its socket was being made: nothing is sent for it.
          if (players.get(key) !== player) return upstream.close()
          player.upstream = upstream
          const [first, ...rest] = player.waiting ?? []
          if (first !== undefined) toGeyser(upstream, { address, port }, first)
          for (const next of rest) upstream.send(next, geyser.port, geyser.hostname)
          player.waiting = null
        })
      },
    },
  })

  const probing = pongProbes(
    toGeyser,
    (packet) => {
      pong = Uint8Array.from(packet)
      pongAt = Date.now()
    },
    options.pongRefreshMs,
  )
  const ask = probing.ask
  ask()
  const asking = setInterval(ask, options.pongRefreshMs)

  const sweeping = setInterval(
    () => {
      const now = Date.now()
      for (const [key, player] of players)
        if (now - player.lastAt >= options.idleMs) players.drop(key, player)
      for (const buckets of [pongAllowed, openAllowed])
        for (const [key, bucket] of buckets) if (bucket.full(now)) buckets.delete(key)
    },
    options.sweepMs ?? 10 * SECOND_MS,
  )

  return {
    players: () => players.size,
    ready,
    forget() {
      pong = null
      players.clear()
    },
    close() {
      clearInterval(asking)
      clearInterval(sweeping)
      front.close()
      probing.close()
      players.clear()
    },
  }
}

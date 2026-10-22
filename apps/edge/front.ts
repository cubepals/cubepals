// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edge's front door: every player's connection arrives here first. It learns who is
 * connecting (from Fly's PROXY header when there is one) and which server they dialled (from the
 * handshake), asks the gate (`limits.ts`) whether that server and that address may have another
 * connection, and hands what it lets in to mc-router, with a PROXY protocol v2 header of its own
 * saying who is connecting. mc-router passes that header on to the server, which so sees each
 * player's own address, not the edge's. A connection to a running server that reads no header
 * goes without one, since one would break it; mc-router then passes none on.
 *
 * mc-router's own limit counts every connection to every server together, and only delays them,
 * so one flooded server used to slow every server's joins. Here a flood is refused at the server
 * it was aimed at, before mc-router or the server sees it.
 *
 * A join from a game the server can't take, by the range on its route, is turned away here too,
 * at once, saying which Minecraft it runs (`clients.ts`).
 *
 * Forwarded identity (Floodgate's data, BungeeCord's, after a NUL in the hostname) is cut from every
 * connection but the edge's own Geyser's, which comes in at a door of its own (`geyserDoor`):
 * loopback only, on a port picked at random each start, and it says whose each connection is in a
 * PROXY v2 header (`bedrock.ts`). The public door never believes such a header.
 *
 * Not for routing: which server a hostname reaches is mc-router's, and the agent's.
 */

import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net'
import {
  LOCAL_HEADER,
  proxyHeader,
  readProxyHeader,
  unmapped,
} from '../../packages/contracts/src/proxy-header.ts'
import { withoutForwarding } from './forwarding.ts'
import { turnAway } from './hold.ts'
import type { Gate } from './limits.ts'
import { hostnameOf, readVarInt } from './notice.ts'
import { sourceKey, type Visits } from './visits.ts'

export interface FrontOptions {
  port: number
  /** Where mc-router listens, on this machine. */
  router: number
  /** Whether every connection opens with a PROXY header, as Fly's proxy sends with `proxy_proto`. */
  proxied: boolean
  gate: Gate
  /** Whether a hostname is a server's: every other hostname is counted as one server. */
  known: (hostname: string) => boolean
  /**
   * Whether a hostname's server is running and reads no PROXY header: its connections reach
   * mc-router without one. Every other connection carries one, which mc-router passes on to the
   * server, or to the agent's own listeners, which read it off (`header.ts`).
   */
  plain: (hostname: string) => boolean
  /** What a join is told when its server is taking no more connections just now. */
  busy: string
  /**
   * What a join to `hostname` from a client speaking `protocol` is told when that game can't join
   * the server (`clients.ts`); null when it can, or when the edge can't tell.
   */
  refuse: (hostname: string, protocol: number) => string | null
  timeouts: Timeouts
  /** Where each join and ping is recorded (`visits.ts`); nothing is, without it. */
  visits?: Visits
}

/** How long a connection the edge makes may wait, to connect and then with nothing said. */
export interface Timeouts {
  /** For the server to take the connection: one that hasn't by then isn't coming. */
  connectMs: number
  /**
   * For anything to pass either way. Minecraft keeps a quiet player's connection going with a
   * keep-alive every 15 s, and drops one that goes 30 s without, so this is longer than that.
   */
  idleMs: number
}

/** How long a connection has to say where it is going, as mc-router allows. */
const GREETING_MS = 5_000
/** Far more than a PROXY header and a handshake ever take. */
const MOST_GREETING = 4096
/** Any line of PROXY protocol v1 fits in this, by its specification. */
const MOST_PROXY_LINE = 107

/** The client's address and port, from the PROXY line or the socket. */
interface Source {
  address: string
  port: number
}

/** Reads a PROXY v1 header off the front of `bytes`: the source and where the rest begins. */
export function readProxyLine(bytes: Uint8Array): { source: Source | null; next: number } | 'more' | 'bad' {
  const end = bytes.indexOf(0x0a)
  if (end === -1) return bytes.length < MOST_PROXY_LINE ? 'more' : 'bad'
  const line = new TextDecoder().decode(bytes.subarray(0, end)).replace(/\r$/, '')
  const [signature, family, address, , port] = line.split(' ')
  if (signature !== 'PROXY') return 'bad'
  // UNKNOWN is a connection the proxy made itself, such as a health check.
  if (family === 'UNKNOWN') return { source: null, next: end + 1 }
  if ((family !== 'TCP4' && family !== 'TCP6') || !address || !port) return 'bad'
  return { source: { address, port: Number(port) }, next: end + 1 }
}

/** What a handshake says: the server dialled, the client's protocol number, and whether it is a join. */
interface Handshake {
  hostname: string
  protocol: number
  joining: boolean
}

/** Reads the handshake at the front of `bytes`. */
export function readHandshake(bytes: Uint8Array): Handshake | 'more' | 'bad' {
  // A server list from before 1.7 pings in a format of its own, which names no server or number.
  if (bytes[0] === 0xfe) return { hostname: '', protocol: -1, joining: false }
  const length = readVarInt(bytes, 0)
  if (length === null) return bytes.length < 5 ? 'more' : 'bad'
  if (length.value <= 0 || length.value > 1024) return 'bad'
  // A handshake is packet 0: anything else is not Minecraft, and needn't be waited for.
  if (bytes.length > length.next && bytes[length.next] !== 0) return 'bad'
  if (length.next + length.value > bytes.length) return 'more'
  const id = readVarInt(bytes, length.next)
  const protocol = id && readVarInt(bytes, id.next)
  const address = protocol && readVarInt(bytes, protocol.next)
  if (id?.value !== 0 || !address) return 'bad'
  const intent = readVarInt(bytes, address.next + address.value + 2)
  if (intent === null || intent.next > length.next + length.value) return 'bad'
  const dialled = new TextDecoder().decode(bytes.subarray(address.next, address.next + address.value))
  return { hostname: hostnameOf({ address: dialled }), protocol: protocol.value, joining: intent.value !== 1 }
}

/**
 * The PROXY header saying `source` connected to the front door's `port`: mc-router reads who is
 * connecting from it, and passes it on. A source with no address, which only a socket already
 * gone has, gets a LOCAL header, as a connection of the edge's own.
 */
function headerFor(source: Source | null, port: number): Uint8Array {
  if (source === null || source.address === '') return LOCAL_HEADER
  const address = unmapped(source.address)
  return proxyHeader(
    { address, port: source.port },
    { address: address.includes(':') ? '::1' : '127.0.0.1', port },
  )
}

/**
 * Connects `client` to the server at `destination`, which first gets what the client sent so far.
 * A server that doesn't take it in time, or a connection gone quiet both ways, is closed.
 */
export function pipe(client: Socket, destination: string, sent: Uint8Array, timeouts: Timeouts): Socket {
  const colon = destination.lastIndexOf(':')
  const server = connect({
    host: destination.slice(0, colon).replace(/^\[|\]$/g, ''),
    port: Number(destination.slice(colon + 1)),
  })
  // A timer of its own: a socket's timeout doesn't run while what is written before it connects waits.
  const connecting = setTimeout(() => server.destroy(), timeouts.connectMs)
  server.once('close', () => clearTimeout(connecting))
  server.once('connect', () => {
    clearTimeout(connecting)
    server.setTimeout(timeouts.idleMs)
  })
  server.on('timeout', () => server.destroy())
  client.on('timeout', () => client.destroy())
  client.setTimeout(timeouts.idleMs)
  server.write(sent)
  client.pipe(server).pipe(client)
  client.once('close', () => server.destroy())
  server.once('close', () => client.destroy())
  client.once('error', () => server.destroy())
  server.once('error', () => client.destroy())
  return server
}

/** One connection from the moment it opens until the gate has let it through or turned it away. */
class Arrival {
  readonly #client: Socket
  readonly #options: FrontOptions
  /** Whether it came in at Geyser's door: its v2 header is believed, and its forwarded identity kept. */
  readonly #geyser: boolean
  #received: Uint8Array = new Uint8Array(0)
  /** Who is connecting; null until the PROXY line says, where one is expected. */
  #source: Source | null = null
  /** Releases the address's place among connections still greeting. */
  #greeted: (() => void) | null = null
  readonly #receive = (chunk: Buffer) => this.#take(chunk)

  constructor(client: Socket, options: FrontOptions, geyser = false) {
    this.#client = client
    this.#options = options
    this.#geyser = geyser
    client.on('error', () => client.destroy())
    client.setTimeout(GREETING_MS, () => client.destroy())
    client.once('close', () => this.#greeted?.())
    if (!options.proxied && !geyser && !this.#greet(this.#socketSource())) return
    client.on('data', this.#receive)
  }

  #socketSource(): Source {
    return { address: this.#client.remoteAddress ?? '', port: this.#client.remotePort ?? 0 }
  }

  /** Counts `source` against its address; false, having closed the connection, when it may not. */
  #greet(source: Source): boolean {
    this.#source = source
    this.#greeted = this.#options.gate.greet(source.address)
    if (!this.#greeted) this.#client.destroy()
    return this.#greeted !== null
  }

  #take(chunk: Buffer): void {
    this.#received = concat(this.#received, chunk)
    if (this.#received.length > MOST_GREETING) return void this.#client.destroy()
    if (this.#source === null && !this.#readSource()) return
    const handshake = readHandshake(this.#received)
    if (handshake === 'more') return
    if (handshake === 'bad') return void this.#client.destroy()
    this.#client.off('data', this.#receive)
    this.#client.pause()
    this.#client.setTimeout(0)
    this.#greeted?.()
    this.#admit(handshake)
  }

  /**
   * Reads who is connecting; whether it was all there and its address may connect. A connection
   * at Geyser's door may open with a v2 header, which is Geyser saying whose it is.
   */
  #readSource(): boolean {
    if (this.#geyser) {
      const header = readProxyHeader(this.#received)
      if (header === 'more') return false
      if (header === 'bad') {
        this.#client.destroy()
        return false
      }
      if (header !== 'none') {
        this.#received = this.#received.slice(header.next)
        return this.#greet(header.source ?? this.#socketSource())
      }
      if (!this.#options.proxied) return this.#greet(this.#socketSource())
    }
    const read = readProxyLine(this.#received)
    if (read === 'more') return false
    // A connection Fly's proxy made itself says nothing more worth hearing.
    if (read === 'bad' || read.source === null) {
      this.#client.destroy()
      return false
    }
    this.#received = this.#received.slice(read.next)
    return this.#greet(read.source)
  }

  #admit(handshake: Handshake): void {
    const { gate, known, plain, busy, refuse, router, port, timeouts } = this.#options
    const visit = this.#visit(handshake)
    // A game the server can't take hears so now, before it is counted, dialled or woken. A ping
    // goes on: what answers it says which Minecraft the server runs, and the list marks it.
    const refused = handshake.joining ? refuse(handshake.hostname, handshake.protocol) : null
    if (refused !== null) {
      visit?.refused('wrong_game')
      return void this.#client.end(turnAway(refused))
    }
    const admitted = gate.admit(known(handshake.hostname) ? handshake.hostname : '')
    if (!admitted) {
      // A ping just goes unanswered; a join hears why, in Cubepals' words.
      if (handshake.joining) this.#client.end(turnAway(busy))
      else this.#client.destroy()
      visit?.refused('busy')
      return
    }
    this.#client.once('close', admitted)
    let sent = this.#geyser ? this.#received : withoutForwarding(this.#received)
    if (!plain(handshake.hostname)) {
      try {
        sent = concat(headerFor(this.#source, port), sent)
      } catch {
        // An address that can't be written in a header: no player's connection has one.
        return void this.#client.destroy()
      }
    }
    const toRouter = pipe(this.#client, `127.0.0.1:${router}`, sent, timeouts)
    visit?.admitted(toRouter)
  }

  /**
   * How this connection is recorded (`visits.ts`): a join from where it came, once let in or turned
   * away, and what passed each way once it closes; a ping, that it was made. Null for neither.
   */
  #visit(
    handshake: Handshake,
  ): { refused: (why: string) => void; admitted: (toRouter: Socket) => void } | null {
    const { visits } = this.#options
    if (visits === undefined || this.#source === null || handshake.hostname === '') return null
    const source = sourceKey(this.#source.address, this.#source.port)
    const dialled = { address: handshake.hostname, protocol: handshake.protocol }
    if (!handshake.joining) {
      // Only a server's own address: anyone can ping a name nobody has, as often as they like.
      if (!this.#options.known(handshake.hostname)) return null
      return { refused: () => {}, admitted: () => visits.pinged(source, handshake.hostname) }
    }
    return {
      refused: (why) => visits.refused(source, dialled, why),
      admitted: (toRouter) => {
        visits.arrived(source, dialled)
        // A connection that carries no PROXY header reaches mc-router from this end of it.
        toRouter.once('connect', () =>
          visits.alias(sourceKey(toRouter.localAddress ?? '', toRouter.localPort ?? 0), source),
        )
        // `bytesRead` came from the player, `bytesWritten` went back to them.
        const client = this.#client
        client.once('close', () => visits.closed(source, { up: client.bytesRead, down: client.bytesWritten }))
      },
    }
  }
}

/** Listens on `options.port` and lets through what the gate allows. */
export function front(options: FrontOptions): Server {
  const listener = createServer((client) => void new Arrival(client, options)).listen(options.port, '0.0.0.0')
  const sweeping = setInterval(() => {
    for (const [counted, times] of options.gate.sweep())
      console.error(`refused ${times} connections: ${counted}`)
  }, 10_000)
  listener.once('close', () => clearInterval(sweeping))
  return listener
}

/**
 * Geyser's door: loopback only, on a port the operating system picks, so nothing but this machine
 * can reach it and nothing else on it knows the port but the agent. Resolves once it listens.
 */
export async function geyserDoor(options: FrontOptions): Promise<{ server: Server; port: number }> {
  const server = createServer((client) => void new Arrival(client, options, true))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length)
  joined.set(a)
  joined.set(b, a.length)
  return joined
}

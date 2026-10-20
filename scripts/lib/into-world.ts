// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A player joining all the way into the world through the edge, timed: the login, the
 * configuration the server sends before the world (its registries, its tags, any resource pack),
 * and the first packet of play, which is the moment the server writes "joined the game". It
 * speaks 1.21.11, which every Paper server takes through its Via plugins, and needs a server with
 * account checks off, since it has no account.
 *
 * It answers what the game answers without asking the player: the edge's login queries, keep-alives
 * and pings. A resource pack offered while joining it never answers, as a player still reading the
 * prompt doesn't, so a join that waits on one runs out of time and says so.
 *
 * Not for the edge's wake: `minecraft.ts`'s `join` times that.
 */
import { Socket } from 'node:net'
import { inflateSync } from 'node:zlib'
import { type Edge, mcString, packet, readVarInt, varInt } from './minecraft.ts'

/** 1.21.11's protocol number and packet ids, from minecraft-data's `pc/1.21.11` (version.json, protocol.json). */
const PROTOCOL = 774
const LOGIN = { disconnect: 0x00, encryption: 0x01, success: 0x02, compress: 0x03, query: 0x04 }
const LOGIN_TO_SERVER = { start: 0x00, queryAnswer: 0x02, acknowledged: 0x03 }
const CONFIGURATION = {
  disconnect: 0x02,
  finish: 0x03,
  keepAlive: 0x04,
  ping: 0x05,
  resourcePack: 0x09,
  knownPacks: 0x0e,
}
const CONFIGURATION_TO_SERVER = { finish: 0x03, keepAlive: 0x04, pong: 0x05, knownPacks: 0x07 }

/** How long a join took, from its connection: logged in, and in the world. */
export interface InWorld {
  loggedInMs: number
  inWorldMs: number
}

interface Settles {
  resolve: (at: InWorld) => void
  reject: (error: Error) => void
}

/** One join, from its connection until the player is in the world or it fails. */
class Joining {
  readonly #socket = new Socket()
  readonly #started = Date.now()
  readonly #settles: Settles
  #state: 'login' | 'configuration' | 'play' = 'login'
  #compressed = false
  #loggedInMs = 0
  #packOffered = false
  #bytes = Buffer.alloc(0)

  constructor(settles: Settles) {
    this.#settles = settles
  }

  start(edge: Edge, address: string, name: string, timeoutMs: number): void {
    const socket = this.#socket
    // A deadline of its own: the server's keep-alives would reset a socket's idle timeout for good.
    const deadline = setTimeout(() => this.#fail(this.#lateness(timeoutMs)), timeoutMs)
    socket.once('close', () => {
      clearTimeout(deadline)
      this.#settles.reject(new Error('the connection closed before the player was in the world'))
    })
    socket.on('error', (error) => this.#fail(error.message))
    socket.on('data', (chunk) => this.#receive(chunk))
    socket.connect(edge.port, edge.host, () => {
      const port = Buffer.alloc(2)
      port.writeUInt16BE(edge.port)
      socket.write(packet(0x00, Buffer.concat([varInt(PROTOCOL), mcString(address), port, varInt(2)])))
      socket.write(packet(LOGIN_TO_SERVER.start, Buffer.concat([mcString(name), Buffer.alloc(16)])))
    })
  }

  #lateness(timeoutMs: number): string {
    const after = `not in the world after ${timeoutMs / 1000}s`
    if (this.#packOffered)
      return `${after}: a resource pack was offered while joining, and the join waited on the answer`
    return `${after}, ${this.#state === 'login' ? 'still logging in' : 'still being configured'}`
  }

  #fail(why: string): void {
    this.#socket.destroy()
    this.#settles.reject(new Error(why))
  }

  /** Once compressed, a packet below the server's threshold, as every one of these is, goes as it is. */
  #send(id: number, payload: Buffer): void {
    const body = Buffer.concat([varInt(id), payload])
    const frame = this.#compressed ? Buffer.concat([varInt(0), body]) : body
    this.#socket.write(Buffer.concat([varInt(frame.length), frame]))
  }

  /** Takes each whole packet that has arrived, in order. */
  #receive(chunk: Buffer): void {
    this.#bytes = Buffer.concat([this.#bytes, chunk])
    for (let frame = this.#nextFrame(); frame !== null; frame = this.#nextFrame()) {
      const [id, at] = readVarInt(frame, 0)
      this.#take(id, frame.subarray(at))
      if (this.#socket.destroyed) return
    }
  }

  /** The next whole packet's id and fields, uncompressed; null until it has all arrived. */
  #nextFrame(): Buffer | null {
    let length: number
    let start: number
    try {
      ;[length, start] = readVarInt(this.#bytes, 0)
    } catch {
      return null
    }
    if (this.#bytes.length < start + length) return null
    const frame = this.#bytes.subarray(start, start + length)
    this.#bytes = this.#bytes.subarray(start + length)
    if (!this.#compressed) return frame
    const [size, at] = readVarInt(frame, 0)
    return size === 0 ? frame.subarray(at) : inflateSync(frame.subarray(at))
  }

  #take(id: number, body: Buffer): void {
    if (this.#state === 'login') return void this.#login(id, body)
    if (this.#state === 'configuration') return void this.#configuration(id, body)
    // Play's first packet: the player is in the world.
    this.#socket.destroy()
    this.#settles.resolve({ loggedInMs: this.#loggedInMs, inWorldMs: Date.now() - this.#started })
  }

  #login(id: number, body: Buffer): void {
    if (id === LOGIN.compress) this.#compressed = true
    else if (id === LOGIN.query)
      this.#send(
        LOGIN_TO_SERVER.queryAnswer,
        Buffer.concat([varInt(readVarInt(body, 0)[0]), Buffer.from([0])]),
      )
    else if (id === LOGIN.encryption) this.#fail('the server wants an account: turn its account checks off')
    else if (id === LOGIN.disconnect) this.#fail(`turned away: ${body.toString('utf8')}`)
    else if (id === LOGIN.success) {
      this.#loggedInMs = Date.now() - this.#started
      this.#send(LOGIN_TO_SERVER.acknowledged, Buffer.alloc(0))
      this.#state = 'configuration'
    }
  }

  #configuration(id: number, body: Buffer): void {
    if (id === CONFIGURATION.knownPacks) this.#send(CONFIGURATION_TO_SERVER.knownPacks, varInt(0))
    else if (id === CONFIGURATION.keepAlive) this.#send(CONFIGURATION_TO_SERVER.keepAlive, body)
    else if (id === CONFIGURATION.ping) this.#send(CONFIGURATION_TO_SERVER.pong, body)
    else if (id === CONFIGURATION.resourcePack) this.#packOffered = true
    else if (id === CONFIGURATION.disconnect) this.#fail('turned away while being configured')
    else if (id === CONFIGURATION.finish) {
      this.#send(CONFIGURATION_TO_SERVER.finish, Buffer.alloc(0))
      this.#state = 'play'
    }
  }
}

/** Joins `address` through `edge` as `name`, until the server puts the player in the world. */
export function intoWorld(edge: Edge, address: string, name: string, timeoutMs = 60_000): Promise<InWorld> {
  return new Promise((resolve, reject) =>
    new Joining({ resolve, reject }).start(edge, address, name, timeoutMs),
  )
}

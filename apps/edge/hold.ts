// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A join held while its server wakes. A sleeping server suspended on Fly resumes and has its
 * player in the world within about 2 s, but one that boots (its first start, after a change, or
 * once Fly drops the snapshot) takes 40 to 50 s. A client
 * gives up on a connection that says nothing for 30 s, so the hold speaks to it while it waits: a
 * login query every few seconds, which every client since 1.13 answers and which counts as the
 * server talking. The answers are kept from the server; everything else the client sent goes on
 * to it once it is up, as if the client had dialled it then.
 *
 * Not for deciding how long to wait or where the join goes: that is the agent's.
 */

import type { Socket } from 'node:net'
import { type Join, packet, readVarInt, string, varInt } from './notice.ts'

/** The first protocol version (1.13) whose clients answer a login query. */
export const LOGIN_QUERIES = 393

/** Login state's query, from the server, and its answer, from the client. */
const QUERY = 0x04
const ANSWER = 0x02
/** A channel no client knows, so every one answers that it didn't understand, and nothing more. */
const CHANNEL = 'blockly:wake'
/** The longest name a Login Start carries, 16 characters, in bytes. */
const NAME_BYTES = 16 * 4
/**
 * Far more than a handshake and a login ever take, in bytes and in packets, all of it kept or
 * still arriving: past either, the client is sending something else.
 */
const MOST_HELD = 64 * 1024
const MOST_KEPT_PACKETS = 64

export class Held {
  /** Every packet the client sent that the server still has to get, in order. */
  readonly #kept: Uint8Array[] = []
  #keptBytes = 0
  /** What arrived of a packet that hasn't arrived whole yet. */
  #pending = new Uint8Array(0)
  #asked = 0
  #answered = 0
  #refused = false

  constructor(join: Join) {
    this.receive(join.bytes)
  }

  /** The next login query to send the client. */
  ask(): Uint8Array {
    this.#asked++
    return packet(QUERY, [...varInt(this.#asked), ...string(CHANNEL)])
  }

  /** Takes what the client sent; false when it is no longer a login waiting to go on. */
  receive(chunk: Uint8Array): boolean {
    if (this.#refused) return false
    const received = new Uint8Array(this.#pending.length + chunk.length)
    received.set(this.#pending)
    received.set(chunk, this.#pending.length)
    let offset = 0
    for (;;) {
      const length = readVarInt(received, offset)
      // No packet is shorter than nothing: this is not a client waiting to log in.
      if (length !== null && length.value < 0) {
        this.#refused = true
        return false
      }
      if (length === null || length.next + length.value > received.length) break
      const end = length.next + length.value
      const id = readVarInt(received, length.next)
      // An answer to one of the hold's own queries is the hold's; the server never asked it.
      if (id?.value === ANSWER && this.#answered < this.#asked) this.#answered++
      else {
        this.#kept.push(received.slice(offset, end))
        this.#keptBytes += end - offset
      }
      offset = end
    }
    this.#pending = received.slice(offset)
    this.#refused =
      this.#keptBytes + this.#pending.length > MOST_HELD || this.#kept.length > MOST_KEPT_PACKETS
    if (this.#refused) {
      this.#kept.length = 0
      this.#pending = new Uint8Array(0)
    }
    return !this.#refused
  }

  /** Whether what the client sent is no longer a login waiting to go on, so nothing wakes for it. */
  get refused(): boolean {
    return this.#refused
  }

  /**
   * The name the client gave as it began to log in, from its Login Start, the packet after the
   * handshake: undefined until that has arrived whole, null where it doesn't read as a name.
   * Claimed by the client, like everything it sends.
   */
  get name(): string | null | undefined {
    const start = this.#kept[1]
    if (start === undefined) return undefined
    const length = readVarInt(start, 0)
    const id = length === null ? null : readVarInt(start, length.next)
    if (id?.value !== 0) return null
    const size = readVarInt(start, id.next)
    if (size === null || size.value < 1 || size.value > NAME_BYTES || size.next + size.value > start.length)
      return null
    return new TextDecoder().decode(start.subarray(size.next, size.next + size.value))
  }

  /** Whether every query has been answered, so nothing of the hold's is still on its way. */
  get settled(): boolean {
    return !this.#refused && this.#answered >= this.#asked
  }

  /** Everything the client sent, but the answers: what the server gets first. */
  replay(): Uint8Array {
    const parts = [...this.#kept, this.#pending]
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    return bytes
  }
}

/** What turns a held join away: login's disconnect, with the message the player reads. */
export function turnAway(text: string): Uint8Array {
  return packet(0, string(JSON.stringify({ text })))
}

/** Turns `client` away at once: the disconnect, then the connection closes once it is sent. */
export function sendAway(client: Socket, text: string): void {
  if (client.writableEnded) return
  client.write(turnAway(text))
  client.destroySoon()
}

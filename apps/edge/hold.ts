/**
 * A join held while its server wakes. A client gives up on a connection that says nothing for
 * 30 s, and a wake takes 40 to 60, so the hold speaks to it while it waits: a login query every
 * few seconds, which every client since 1.13 answers and which counts as the server talking. The
 * answers are kept from the server; everything else the client sent goes on to it once it is up,
 * as if the client had dialled it then.
 *
 * Not for deciding how long to wait or where the join goes: that is the agent's.
 */

import { type Join, packet, readVarInt, string, varInt } from './notice.ts'

/** The first protocol version (1.13) whose clients answer a login query. */
export const LOGIN_QUERIES = 393

/** Login state's query, from the server, and its answer, from the client. */
const QUERY = 0x04
const ANSWER = 0x02
/** A channel no client knows, so every one answers that it didn't understand, and nothing more. */
const CHANNEL = 'blockly:wake'
/** Far more than a handshake and a login ever take: past this, the client is sending something else. */
const MOST_PENDING = 64 * 1024

export class Held {
  /** Every packet the client sent that the server still has to get, in order. */
  readonly #kept: Uint8Array[] = []
  /** What arrived of a packet that hasn't arrived whole yet. */
  #pending = new Uint8Array(0)
  #asked = 0
  #answered = 0

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
    const received = new Uint8Array(this.#pending.length + chunk.length)
    received.set(this.#pending)
    received.set(chunk, this.#pending.length)
    let offset = 0
    for (;;) {
      const length = readVarInt(received, offset)
      if (length === null || length.next + length.value > received.length) break
      const end = length.next + length.value
      const id = readVarInt(received, length.next)
      // An answer to one of the hold's own queries is the hold's; the server never asked it.
      if (id?.value === ANSWER && this.#answered < this.#asked) this.#answered++
      else this.#kept.push(received.slice(offset, end))
      offset = end
    }
    this.#pending = received.slice(offset)
    return this.#pending.length <= MOST_PENDING
  }

  /** Whether every query has been answered, so nothing of the hold's is still on its way. */
  get settled(): boolean {
    return this.#answered >= this.#asked
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

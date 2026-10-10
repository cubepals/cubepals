// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// What a player's client is told about a server that can't be joined as it is, spoken as a
// Minecraft server would: the server list gets a status with the message, and a join is turned
// away with it, or handed back to be connected elsewhere.

/** What the server list shows, and what a join is told; null hands the join back instead. */
export interface NoticeText {
  status: string
  join: string | null
}

/**
 * A join handed back: the address the client dialled, its protocol version, and every byte it has
 * sent so far.
 */
export interface Join {
  address: string
  protocol: number
  bytes: Uint8Array
}

/** A varint at `offset`, and where the next field begins; null when the bytes end first or run on. */
export function readVarInt(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const byte = bytes[offset + i]
    if (byte === undefined) return null
    value |= (byte & 0x7f) << (7 * i)
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 }
  }
  return null
}

export function varInt(value: number): number[] {
  const bytes: number[] = []
  let rest = value >>> 0
  do {
    const byte = rest & 0x7f
    rest >>>= 7
    bytes.push(rest === 0 ? byte : byte | 0x80)
  } while (rest !== 0)
  return bytes
}

export function string(text: string): number[] {
  const bytes = new TextEncoder().encode(text)
  return [...varInt(bytes.length), ...bytes]
}

/** A packet as it goes on the wire: its length, its id, then its fields. */
export function packet(id: number, fields: readonly number[]): Uint8Array {
  const body = [...varInt(id), ...fields]
  return Uint8Array.from([...varInt(body.length), ...body])
}

/** What a server list sends to ask a server how it is: a handshake, then a status request. */
export function statusRequest(address: string, port: number): Uint8Array {
  const handshake = packet(0, [...varInt(767), ...string(address), port >> 8, port & 0xff, 1])
  return Uint8Array.from([...handshake, ...packet(0, [])])
}

/** One connection's conversation, fed the bytes as they arrive. */
export class Notice {
  readonly #text: NoticeText
  #received = new Uint8Array(0)
  #protocol: number | null = null

  constructor(text: NoticeText) {
    this.#text = text
  }

  /**
   * Takes what the client sent; returns what to answer, and whether the conversation is over, or
   * the join to hand back, after which this conversation takes nothing more.
   */
  receive(chunk: Uint8Array): { reply: Uint8Array[]; close: boolean; join?: Join } {
    const received = new Uint8Array(this.#received.length + chunk.length)
    received.set(this.#received)
    received.set(chunk, this.#received.length)
    this.#received = received
    // A client from before 1.7 pings in a format of its own; it is simply not answered. Nor is
    // anything that goes on far longer than a handshake and a ping ever do.
    if ((this.#protocol === null && received[0] === 0xfe) || received.length > 4096)
      return { reply: [], close: true }

    const reply: Uint8Array[] = []
    let offset = 0
    for (;;) {
      const length = readVarInt(received, offset)
      if (length === null || length.value < 0 || length.next + length.value > received.length) break
      const start = offset
      const end = length.next + length.value
      const id = readVarInt(received, length.next)
      if (id === null) return { reply, close: true }
      offset = end
      if (this.#protocol === null) {
        // The handshake: the client's protocol version, the address it dialled, and what it wants.
        const protocol = readVarInt(received, id.next)
        if (id.value !== 0 || protocol === null) return { reply, close: true }
        const address = readVarInt(received, protocol.next)
        if (address === null) return { reply, close: true }
        const intent = readVarInt(received, address.next + address.value + 2)
        if (intent === null) return { reply, close: true }
        this.#protocol = protocol.value
        // Anything but a status request is a join, in any version's words for it.
        if (intent.value !== 1 && this.#text.join === null) {
          const dialled = new TextDecoder().decode(
            received.subarray(address.next, address.next + address.value),
          )
          return {
            reply,
            close: false,
            join: { address: dialled, protocol: protocol.value, bytes: received },
          }
        }
        if (intent.value !== 1)
          return {
            reply: [...reply, packet(0, string(JSON.stringify({ text: this.#text.join })))],
            close: true,
          }
      } else if (id.value === 0) {
        const status = {
          version: { name: this.#text.status, protocol: this.#protocol },
          players: { max: 0, online: 0 },
          description: { text: this.#text.status },
        }
        reply.push(packet(0, string(JSON.stringify(status))))
      } else if (id.value === 1) {
        // The ping goes back as it came, so the list can show how far away the server is.
        return { reply: [...reply, received.slice(start, end)], close: true }
      } else return { reply, close: true }
    }
    this.#received = received.slice(offset)
    return { reply, close: false }
  }
}

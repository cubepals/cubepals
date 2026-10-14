// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The PROXY header on the agent's own listeners (the notices and the waiting room). mc-router
 * passes on the header the front door gave a connection, to whichever backend it picks, so a
 * connection reaching one of them may open with one: it is read off before the handshake, and kept
 * for the server the connection goes on to, if that server reads one.
 *
 * Not for deciding which connections carry a header from the front door: that is `front.ts`'s.
 */

import { LOCAL_HEADER, readProxyHeader } from '../../packages/contracts/src/proxy-header.ts'

/** Reads a connection's PROXY header, if it has one, off the front of what it sends. */
export class Unwrap {
  #pending: Uint8Array = new Uint8Array(0)
  #read = false
  /** The header the connection opened with, as it came; null when it had none. */
  header: Uint8Array | null = null

  /**
   * The connection's own bytes in `chunk`, past any header; null while what came so far may still
   * be a header cut short, and `bad` for a header that isn't one.
   */
  take(chunk: Uint8Array): Uint8Array | null | 'bad' {
    if (this.#read) return chunk
    const bytes = new Uint8Array(this.#pending.length + chunk.length)
    bytes.set(this.#pending)
    bytes.set(chunk, this.#pending.length)
    const read = readProxyHeader(bytes)
    if (read === 'more') {
      this.#pending = bytes
      return null
    }
    if (read === 'bad') return 'bad'
    this.#read = true
    this.#pending = new Uint8Array(0)
    if (read === 'none') return bytes
    this.header = bytes.slice(0, read.next)
    return bytes.subarray(read.next)
  }
}

/**
 * What a server is sent first: `bytes`, after the connection's header where the server reads one.
 * A connection that came without one, as one to a server that read none when it arrived, gets a
 * LOCAL header, which the server takes as the edge's own connection rather than turning it away.
 */
export function forServer(readsHeader: boolean, header: Uint8Array | null, bytes: Uint8Array): Uint8Array {
  if (!readsHeader) return bytes
  const opening = header ?? LOCAL_HEADER
  const sent = new Uint8Array(opening.length + bytes.length)
  sent.set(opening)
  sent.set(bytes, opening.length)
  return sent
}

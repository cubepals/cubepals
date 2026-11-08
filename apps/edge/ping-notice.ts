// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator's notice on a running server's owner, in the multiplayer list. The server answers
 * its own pings, so the front door passes the ping on as ever and changes only the answer on its
 * way back: the status's message becomes the notice, and everything else the server said (its
 * players, its version, its picture) goes as it came. The server's own setting is never touched,
 * so nothing restarts for it. An answer that can't be read goes on unchanged.
 *
 * Not for a sleeping server's answer, which is the agent's own and says the notice itself
 * (`asleep.ts` `noticedMessage`), or for whether a ping gets the notice (its route's `notice`).
 */
import type { EdgeRoute } from '@blockly/contracts/edge'
import { packet, readVarInt, string } from './notice.ts'

/**
 * The most a packet may hold, by the protocol: its length is a varint of at most three bytes
 * (https://minecraft.wiki/w/Java_Edition_protocol/Packets, "Packet format"). A status answer that
 * says it is longer is not one, and passes on unread.
 */
const MOST_PACKET = 2 ** 21 - 1

const NOTHING = new Uint8Array(0)

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length)
  joined.set(a)
  joined.set(b, a.length)
  return joined
}

/** The status answer `status` (one whole packet) with `notice` as its message; null if it isn't one. */
export function withNotice(status: Uint8Array, notice: string): Uint8Array | null {
  const length = readVarInt(status, 0)
  const id = length && readVarInt(status, length.next)
  const size = id && readVarInt(status, id.next)
  if (id?.value !== 0 || !size || size.next + size.value !== status.length) return null
  try {
    const answer: unknown = JSON.parse(new TextDecoder().decode(status.subarray(size.next)))
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return null
    return packet(0, string(JSON.stringify({ ...answer, description: { text: notice } })))
  } catch {
    return null
  }
}

/**
 * What a server sends back to one ping, on its way to the player: its first packet, the status,
 * held until it is whole and given the notice; everything after it as it comes.
 */
export class StatusRewrite {
  readonly #notice: string
  /** What has come of the status so far; null once it has gone on. */
  #held: Uint8Array | null = NOTHING

  constructor(notice: string) {
    this.#notice = notice
  }

  /** What of `chunk` goes on to the player now: nothing while the status is still arriving. */
  take(chunk: Uint8Array): Uint8Array {
    if (this.#held === null) return chunk
    const held = concat(this.#held, chunk)
    const length = readVarInt(held, 0)
    const end = length === null ? null : length.next + length.value
    if (length === null && held.length < 5) return this.#hold(held)
    // An answer that isn't a status goes on as it came, and so does all that follows it.
    this.#held = null
    if (end === null || end > MOST_PACKET) return held
    if (held.length < end) return this.#hold(held)
    return concat(
      withNotice(held.subarray(0, end), this.#notice) ?? held.subarray(0, end),
      held.subarray(end),
    )
  }

  /** What it still holds, as it came: for a server whose side ends before its status is whole. */
  flush(): Uint8Array {
    const held = this.#held ?? NOTHING
    this.#held = null
    return held
  }

  #hold(held: Uint8Array): Uint8Array {
    this.#held = held
    return NOTHING
  }
}

/**
 * What a ping to `route` goes back through: its owner's notice, for a server that is running and
 * so answers for itself; null for one with no notice, or one the agent answers for.
 */
export function runningNotice(route: EdgeRoute | undefined): StatusRewrite | null {
  return route?.notice && route.state === undefined ? new StatusRewrite(route.notice) : null
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A held join that is told how long its world takes. A client from 1.21.6 on takes a dialog while
 * it configures, so once its server is clearly booting, the edge finishes the login itself, with
 * no encryption and no account check, lets the client into configuration, and shows a notice:
 * "Waking your world · about N seconds", refreshed as it counts down, with a keep-alive between.
 * Once the server is up the client is sent a Transfer to the address it dialled, and joins it
 * afresh: the server does its own whole login, with its own account check. The front door lets a
 * transfer in as a plain join (`forwarding.ts`), so no server has to accept transfers.
 *
 * The edge learns nothing it trusts here: the name and uuid the client claims go back to it only.
 *
 * Not for when to switch or for how long to wait (the waiting room's), nor for a client older
 * than 1.21.6, a Forge client or a Bedrock player through Geyser, which keep the login hold
 * (`hold.ts`).
 */

import { type HoldPackets, packetsFor } from './hold-packet-ids.ts'
import { networkNbt } from './nbt.ts'
import { type Join, packet, readVarInt, string, varInt } from './notice.ts'

/** The most a configuring client sends while it waits: its settings, brand and channels, many times over. */
const MOST_RECEIVED = 256 * 1024

/** A Login Start's fields, as 1.20.2 on send them: the name, then the account's uuid. */
export interface LoginStart {
  name: string
  uuid: Uint8Array
}

/** The packets after the handshake in `bytes`, each from its id on; stops at the first that isn't whole. */
function packetsIn(bytes: Uint8Array): { id: number; body: Uint8Array }[] {
  const found: { id: number; body: Uint8Array }[] = []
  let offset = 0
  for (;;) {
    const length = readVarInt(bytes, offset)
    if (length === null || length.value < 1 || length.next + length.value > bytes.length) return found
    const end = length.next + length.value
    const id = readVarInt(bytes, length.next)
    if (id === null || id.next > end) return found
    found.push({ id: id.value, body: bytes.subarray(id.next, end) })
    offset = end
  }
}

/** The Login Start that follows the handshake in what a join sent; null until it is whole, or where it isn't one. */
export function loginStartOf(bytes: Uint8Array): LoginStart | null {
  const start = packetsIn(bytes)[1]
  if (start === undefined || start.id !== 0) return null
  const size = readVarInt(start.body, 0)
  if (size === null || size.value < 1 || size.value > 64 || size.next + size.value + 16 !== start.body.length)
    return null
  const name = new TextDecoder().decode(start.body.subarray(size.next, size.next + size.value))
  return { name, uuid: start.body.slice(size.next + size.value) }
}

/** The port the client dialled, from its handshake; null where the handshake isn't whole. */
export function portOf(bytes: Uint8Array): number | null {
  const hello = packetsIn(bytes)[0]
  if (hello === undefined || hello.id !== 0) return null
  const protocol = readVarInt(hello.body, 0)
  const address = protocol && readVarInt(hello.body, protocol.next)
  if (!address) return null
  const at = address.next + address.value
  const high = hello.body[at]
  const low = hello.body[at + 1]
  return high === undefined || low === undefined ? null : (high << 8) | low
}

/**
 * The ids to hold `join` with a dialog, or null where it keeps the login hold: a client whose
 * protocol no report covers, or one that sent more after the hostname (Forge's marker, Geyser's
 * Floodgate data), which speaks to servers in ways of its own.
 */
export function dialogFor(join: Join): HoldPackets | null {
  if (join.address.includes('\0')) return null
  return packetsFor(join.protocol)
}

/** A text component as NBT carries it from 1.20.3 on: the plain text, as a string tag. */
const text = (words: string): number[] => networkNbt(words)

export class DialogHold {
  readonly #ids: HoldPackets
  #configuring = false
  #pending = new Uint8Array(0)
  #received = 0
  #asked = 0n

  constructor(ids: HoldPackets) {
    this.#ids = ids
  }

  /** Ends the login as an offline server would: the name and uuid the client gave, and no properties. */
  finishLogin(start: LoginStart): Uint8Array {
    return packet(this.#ids.login.finished, [...start.uuid, ...string(start.name), ...varInt(0)])
  }

  /**
   * Takes what the client sent after the hold finished its login: false once it sends far more
   * than a waiting client does. Before its Login Acknowledged, that is only answers to the login
   * hold's queries; after, its settings and channels, and its answers to keep-alives. None of it
   * goes anywhere: the client joins the server afresh.
   */
  receive(chunk: Uint8Array): boolean {
    this.#received += chunk.length
    if (this.#received > MOST_RECEIVED) return false
    const bytes = new Uint8Array(this.#pending.length + chunk.length)
    bytes.set(this.#pending)
    bytes.set(chunk, this.#pending.length)
    let offset = 0
    for (;;) {
      const length = readVarInt(bytes, offset)
      if (length === null || length.next + length.value > bytes.length) break
      if (length.value < 1) return false
      const id = readVarInt(bytes, length.next)
      if (!this.#configuring && id?.value === this.#ids.login.acknowledged) this.#configuring = true
      offset = length.next + length.value
    }
    this.#pending = bytes.slice(offset)
    return true
  }

  /** Whether the client acknowledged the login, so it is configuring and takes the dialog. */
  get configuring(): boolean {
    return this.#configuring
  }

  /** A notice titled `title` that says `line`, which Escape closes, back to the joining screen. */
  dialog(title: string, line: string): Uint8Array {
    const notice = {
      type: 'minecraft:notice',
      title,
      body: [{ type: 'minecraft:plain_message', contents: line }],
      can_close_with_escape: true,
    }
    return packet(this.#ids.configuration.showDialog, networkNbt(notice))
  }

  /** A keep-alive, so the client knows the server is still there while nothing else changes. */
  keepAlive(): Uint8Array {
    this.#asked += 1n
    const id = new Uint8Array(8)
    new DataView(id.buffer).setBigInt64(0, this.#asked)
    return packet(this.#ids.configuration.keepAlive, [...id])
  }

  /** Sends the client to join `host`:`port` afresh. */
  transfer(host: string, port: number): Uint8Array {
    return packet(this.#ids.configuration.transfer, [...string(host), ...varInt(port)])
  }

  /** Ends the hold with `words` on the disconnect screen. */
  turnAway(words: string): Uint8Array {
    return packet(this.#ids.configuration.disconnect, text(words))
  }
}

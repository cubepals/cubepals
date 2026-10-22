// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Takes forwarded identity out of a Java handshake. A hostname may carry more after a NUL byte: Forge's
 * marker, BungeeCord's forwarded address, uuid and properties, and Floodgate's encrypted Bedrock
 * identity. A server that reads them believes them, and one Floodgate key is shared by every server
 * (and readable by a server's own plugins), so only the edge's own Geyser may send any: the front
 * door runs every other connection's handshake through here (`front.ts`). Not for routing, which
 * reads the hostname up to the NUL (`notice.ts`).
 */

import { packet, readVarInt, string, varInt } from './notice.ts'

/** The only thing after a NUL that is not forwarding: the marker a Forge client adds. */
const FORGE_MARKER = /^\0FML\d*\0$/

/**
 * `bytes` with the handshake's hostname cut at its first NUL, unless what follows is only Forge's
 * marker. Everything after the handshake packet is passed on as it came. Bytes that aren't a whole
 * handshake come back as they were.
 */
export function withoutForwarding(bytes: Uint8Array): Uint8Array {
  const length = readVarInt(bytes, 0)
  const id = length && readVarInt(bytes, length.next)
  const protocol = id && readVarInt(bytes, id.next)
  const address = protocol && readVarInt(bytes, protocol.next)
  if (!length || id?.value !== 0 || !protocol || !address) return bytes
  const end = length.next + length.value
  const hostEnd = address.next + address.value
  if (end > bytes.length || hostEnd > end) return bytes
  const host = new TextDecoder().decode(bytes.subarray(address.next, hostEnd))
  const nul = host.indexOf('\0')
  if (nul === -1 || FORGE_MARKER.test(host.slice(nul))) return bytes
  // Its port and intent follow the hostname, unchanged.
  const fields = [...varInt(protocol.value), ...string(host.slice(0, nul)), ...bytes.subarray(hostEnd, end)]
  const rewritten = packet(0, fields)
  const out = new Uint8Array(rewritten.length + bytes.length - end)
  out.set(rewritten)
  out.set(bytes.subarray(end), rewritten.length)
  return out
}

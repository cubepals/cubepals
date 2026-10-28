// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { Socket } from 'node:net'
import { LOCAL_HEADER } from '@blockly/contracts/proxy-header'
import type { GameEndpoint, ReadinessProbe, ServerStatusPing } from '../../app/ports/minecraft.ts'

/**
 * Minecraft's Server List Ping (1.7+): the same question the multiplayer screen asks. A server
 * that answers it has finished loading its world and accepts players.
 *
 * Hand-written on purpose (docs/dependency-audit.md). `minecraft-protocol` timed out on fragmented
 * and coalesced replies and brings 450 MB of dependencies; `minecraftstatuspinger` works but only
 * notices a closed connection at its deadline. Docker's health status cannot stand in for it: Fly
 * machines run only TCP or HTTP checks, a TCP check passes before the world has loaded, and the
 * image's own check stayed "healthy" for 43 seconds while the server was frozen.
 */

/**
 * The status JSON is a protocol string of at most 32767 UTF-16 units, read by the game as at most
 * three bytes each.
 */
const MOST_STATUS_STRING_BYTES = 32_767 * 3
/** A status frame's body: the packet id, the string's length, the string. */
const MOST_STATUS_FRAME = 1 + 3 + MOST_STATUS_STRING_BYTES

function varInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    bytes.push(byte)
  } while (v !== 0)
  return Buffer.from(bytes)
}

function frame(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([varInt(id), payload])
  return Buffer.concat([varInt(body.length), body])
}

function readVarInt(buffer: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null
    const byte = buffer[offset + i] ?? 0
    value |= (byte & 0x7f) << (7 * i)
    if ((byte & 0x80) === 0) return { value, size: i + 1 }
  }
  throw new Error('Malformed status response')
}

/**
 * One status reply as it arrives. Chunks are kept apart and joined once the frame is whole, or
 * while its length is still unread; a length outside the protocol's bounds is refused at once.
 */
class StatusReply {
  #chunks: Buffer[] = []
  #received = 0
  #frame: { at: number; end: number } | null = null

  /** The status JSON once the frame is whole, or null while more is to come. */
  take(chunk: Buffer): string | null {
    this.#chunks.push(chunk)
    this.#received += chunk.length
    const frame = this.#frame ?? this.#readLength()
    if (frame === null || this.#received < frame.end) return null
    const buffer = Buffer.concat(this.#chunks)
    const id = readVarInt(buffer, frame.at)
    if (id === null || id.value !== 0x00) throw new Error('Unexpected status packet')
    const strLength = readVarInt(buffer, frame.at + id.size)
    const start = frame.at + id.size + (strLength?.size ?? 0)
    if (strLength === null || strLength.value < 0 || start + strLength.value > frame.end)
      throw new Error('The status reply is shorter than the string it declares')
    return buffer.toString('utf8', start, start + strLength.value)
  }

  #readLength(): { at: number; end: number } | null {
    const head = Buffer.concat(this.#chunks)
    this.#chunks = [head]
    const length = readVarInt(head, 0)
    if (length === null) return null
    if (length.value < 1 || length.value > MOST_STATUS_FRAME)
      throw new Error(`A status reply of ${length.value} bytes is outside 1 to ${MOST_STATUS_FRAME}`)
    this.#frame = { at: length.size, end: length.size + length.value }
    return this.#frame
  }
}

function statusOf(text: string): ServerStatusPing {
  const json = JSON.parse(text) as {
    players?: { online?: number; max?: number }
    version?: { name?: string }
  }
  // Something answered before the game did: a reply naming no version is no server yet
  // (seen 2026-09-26 on Forge packs, answering long before "Done").
  if (!json.version?.name) throw new Error('The server answered before Minecraft was up')
  return {
    online: json.players?.online ?? 0,
    max: json.players?.max ?? 0,
    version: json.version?.name ?? '',
  }
}

export class SlpProbe implements ReadinessProbe {
  ping(endpoint: GameEndpoint, signal: AbortSignal): Promise<ServerStatusPing> {
    return new Promise((resolve, reject) => {
      const socket = new Socket()
      let settled = false
      const finish = (error: Error | null, result?: ServerStatusPing) => {
        if (settled) return
        settled = true
        socket.destroy()
        signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else if (result) resolve(result)
      }
      const onAbort = () => finish(new Error('The status ping timed out'))
      signal.addEventListener('abort', onAbort, { once: true })
      // A router with no route for the name closes without a word.
      socket.once('close', () => finish(new Error('The server closed the connection without answering')))

      socket.once('error', (error) => finish(error))
      socket.connect(endpoint.port, endpoint.host, () => {
        const host = Buffer.from(endpoint.host, 'utf8')
        const port = Buffer.alloc(2)
        port.writeUInt16BE(endpoint.port)
        const handshake = Buffer.concat([varInt(0xffffffff), varInt(host.length), host, port, varInt(1)])
        // A ping is the control plane's own connection, not a player's: the server keeps its address.
        if (endpoint.proxyProtocol) socket.write(LOCAL_HEADER)
        socket.write(frame(0x00, handshake))
        socket.write(frame(0x00, Buffer.alloc(0)))
      })
      const reply = new StatusReply()
      socket.on('data', (chunk) => {
        try {
          const text = reply.take(chunk)
          if (text !== null) finish(null, statusOf(text))
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }
}

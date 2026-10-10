// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { Socket } from 'node:net'
import type { ReadinessProbe, ServerStatusPing } from '../../app/ports/minecraft.ts'
import type { Endpoint } from '../../app/ports/runtime.ts'

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

export class SlpProbe implements ReadinessProbe {
  ping(endpoint: Endpoint, signal: AbortSignal): Promise<ServerStatusPing> {
    return new Promise((resolve, reject) => {
      const socket = new Socket()
      let buffer = Buffer.alloc(0)
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
        socket.write(frame(0x00, handshake))
        socket.write(frame(0x00, Buffer.alloc(0)))
      })
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        try {
          const length = readVarInt(buffer, 0)
          if (length === null || buffer.length < length.size + length.value) return
          const id = readVarInt(buffer, length.size)
          if (id === null || id.value !== 0x00) throw new Error('Unexpected status packet')
          const strLength = readVarInt(buffer, length.size + id.size)
          if (strLength === null) return
          const start = length.size + id.size + strLength.size
          const json = JSON.parse(buffer.toString('utf8', start, start + strLength.value)) as {
            players?: { online?: number; max?: number }
            version?: { name?: string }
          }
          // Something answered before the game did: a reply naming no version is no server yet
          // (seen 2026-09-26 on Forge packs, answering long before "Done").
          if (!json.version?.name) throw new Error('The server answered before Minecraft was up')
          finish(null, {
            online: json.players?.online ?? 0,
            max: json.players?.max ?? 0,
            version: json.version?.name ?? '',
          })
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }
}

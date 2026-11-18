// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One Java player's join in the game's own protocol, for a release no client library speaks yet
 * (26.3): the server list's ping for its protocol number, then the handshake, the login, and the
 * configuration phase through to the first packet of play, which is the moment the player is in the
 * world. Since 1.21.9 the configuration phase is where the server makes the spawn a player lands in,
 * so a new world's first join waits there.
 *
 *   bun scripts/lib/raw-join.ts <address> <name> [seconds]
 *
 * It prints one JSON line: `steps` in ms from the start (`pinged`, `connected`, `loggedIn`,
 * `configured`, `spawned`), or `error`. Offline mode only: a server that asks for encryption ends
 * it. It answers what the configuration phase waits on (keep-alives, pings, known packs, cookies)
 * and nothing else. Packet ids are 26.1's to 26.3's, from minecraft-data's 26.1 protocol for the
 * login and configuration states, which 26.2 and 26.3 left as they were.
 *
 * Not a player: it leaves as soon as it is in the world.
 */
import { Socket } from 'node:net'
import { inflateSync } from 'node:zlib'
import { GAME_PORT } from '../../apps/control/src/minecraft/ports.ts'

const LOGIN = { disconnect: 0x00, encryption: 0x01, success: 0x02, compress: 0x03, cookie: 0x05 } as const
const CONFIG = {
  cookie: 0x00,
  disconnect: 0x02,
  finish: 0x03,
  keepAlive: 0x04,
  ping: 0x05,
  knownPacks: 0x0e,
} as const
const TO_SERVER = {
  loginStart: 0x00,
  cookieLogin: 0x04,
  loginAck: 0x03,
  cookieConfig: 0x01,
  finish: 0x03,
  keepAlive: 0x04,
  pong: 0x05,
  knownPacks: 0x07,
} as const

/** What the configuration phase waits on an answer to, and the answer: the same body back (a cookie's key with none). */
const REPLIES = new Map<number, number>([
  [CONFIG.keepAlive, TO_SERVER.keepAlive],
  [CONFIG.ping, TO_SERVER.pong],
  [CONFIG.knownPacks, TO_SERVER.knownPacks],
  [CONFIG.cookie, TO_SERVER.cookieConfig],
])

function varInt(value: number): Buffer {
  const bytes: number[] = []
  let rest = value >>> 0
  do {
    let byte = rest & 0x7f
    rest >>>= 7
    if (rest !== 0) byte |= 0x80
    bytes.push(byte)
  } while (rest !== 0)
  return Buffer.from(bytes)
}

/** A VarInt at `at`, and where the next field begins; null while the bytes aren't all here. */
function readVarInt(buffer: Buffer, at: number): [number, number] | null {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const byte = buffer[at + i]
    if (byte === undefined) return null
    value |= (byte & 0x7f) << (7 * i)
    if ((byte & 0x80) === 0) return [value, at + i + 1]
  }
  throw new Error('VarInt too long')
}

const text = (value: string) => {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([varInt(bytes.length), bytes])
}

/** The first whole packet in `buffer`: its id, its body and how many bytes it took; null until all of it is here. */
function nextPacket(buffer: Buffer, compressed: boolean): { id: number; body: Buffer; took: number } | null {
  const length = readVarInt(buffer, 0)
  if (length === null || length[1] + length[0] > buffer.length) return null
  let body = buffer.subarray(length[1], length[1] + length[0])
  if (compressed) {
    const [size, from] = readVarInt(body, 0) ?? [0, 0]
    body = size === 0 ? body.subarray(from) : inflateSync(body.subarray(from))
  }
  const [id, from] = readVarInt(body, 0) ?? [-1, 0]
  return { id, body: body.subarray(from), took: length[1] + length[0] }
}

const framed = (id: number, body: Buffer, compressed: boolean) => {
  const payload = Buffer.concat([varInt(id), body])
  const inner = compressed ? Buffer.concat([varInt(0), payload]) : payload
  return Buffer.concat([varInt(inner.length), inner])
}

/** The protocol number the server list says, by the status ping. */
function protocolOf(host: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    let buffer = Buffer.alloc(0)
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('no answer to the status ping')))
    socket.on('error', reject)
    socket.connect(GAME_PORT, host, () => {
      const handshake = Buffer.concat([
        varInt(-1),
        text(host),
        Buffer.from([GAME_PORT >> 8, GAME_PORT & 0xff]),
        varInt(1),
      ])
      socket.write(Buffer.concat([framed(0x00, handshake, false), framed(0x00, Buffer.alloc(0), false)]))
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const body = nextPacket(buffer, false)?.body
      if (body === undefined) return
      const [length, from] = readVarInt(body, 0) ?? [0, 0]
      const status = JSON.parse(body.subarray(from, from + length).toString('utf8'))
      socket.destroy()
      resolve(status.version.protocol)
    })
  })
}

/** An offline player's UUID, as the server derives it from the name. */
function offlineUuid(name: string): Buffer {
  const hash = new Bun.CryptoHasher('md5').update(`OfflinePlayer:${name}`).digest()
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x30
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  return Buffer.from(hash)
}

async function join(host: string, name: string, timeoutMs: number) {
  const begun = performance.now()
  const steps: Record<string, number> = {}
  const mark = (step: string) => {
    steps[step] = Math.round(performance.now() - begun)
  }
  const protocol = await protocolOf(host, timeoutMs)
  mark('pinged')
  return new Promise<Record<string, unknown>>((resolve) => {
    const socket = new Socket()
    let buffer = Buffer.alloc(0)
    let compressed = false
    let state: 'login' | 'configuration' | 'play' = 'login'
    const send = (id: number, body: Buffer = Buffer.alloc(0)) => socket.write(framed(id, body, compressed))
    const end = (result: Record<string, unknown>) => {
      socket.destroy()
      resolve({ protocol, steps, ...result })
    }
    socket.setTimeout(timeoutMs, () => end({ error: `timed out in ${state}` }))
    socket.on('error', (error) => end({ error: error.message }))
    socket.on('close', () => end({ error: `closed in ${state}` }))
    socket.connect(GAME_PORT, host, () => {
      mark('connected')
      const handshake = Buffer.concat([
        varInt(protocol),
        text(host),
        Buffer.from([GAME_PORT >> 8, GAME_PORT & 0xff]),
        varInt(2),
      ])
      socket.write(framed(0x00, handshake, false))
      send(TO_SERVER.loginStart, Buffer.concat([text(name), offlineUuid(name)]))
    })
    const login = (id: number, body: Buffer) => {
      if (id === LOGIN.compress) compressed = true
      else if (id === LOGIN.cookie) send(TO_SERVER.cookieLogin, Buffer.concat([body, Buffer.from([0])]))
      else if (id === LOGIN.encryption) end({ error: 'the server checks accounts' })
      else if (id === LOGIN.disconnect) end({ error: `turned away: ${body.toString('utf8').slice(0, 200)}` })
      else if (id === LOGIN.success) {
        mark('loggedIn')
        send(TO_SERVER.loginAck)
        state = 'configuration'
      }
    }
    const configuration = (id: number, body: Buffer) => {
      const reply = REPLIES.get(id)
      if (reply !== undefined)
        send(reply, id === CONFIG.cookie ? Buffer.concat([body, Buffer.from([0])]) : body)
      else if (id === CONFIG.disconnect) end({ error: 'turned away while configuring' })
      else if (id === CONFIG.finish) {
        mark('configured')
        send(TO_SERVER.finish)
        state = 'play'
      }
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      // One packet at a time: compression starts with the packet after Set Compression.
      for (let next = nextPacket(buffer, compressed); next !== null; next = nextPacket(buffer, compressed)) {
        buffer = buffer.subarray(next.took)
        if (state === 'play') {
          mark('spawned')
          return end({})
        }
        if (state === 'login') login(next.id, next.body)
        else configuration(next.id, next.body)
      }
    })
  })
}

if (import.meta.main) {
  const [address = '', name = 'RawJoin', seconds = '120'] = process.argv.slice(2)
  const result = await join(address, name, Number(seconds) * 1000).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }))
  process.stdout.write(`${JSON.stringify({ job: 'raw-join', address, name, ...result })}\n`)
  process.exit(0)
}

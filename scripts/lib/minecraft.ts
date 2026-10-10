// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Minecraft client just far enough to be a player at the edge: the handshake and login the
 * game sends when someone clicks Join, and a status ping. The smoke test and the staging check
 * use it against whichever edge they test.
 */
import { Socket } from 'node:net'

/** Where players connect: the edge's address and its Minecraft port. */
export interface Edge {
  host: string
  port: number
}

const varInt = (value: number) => {
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
const packet = (id: number, payload: Buffer) => {
  const body = Buffer.concat([varInt(id), payload])
  return Buffer.concat([varInt(body.length), body])
}
const mcString = (text: string) => Buffer.concat([varInt(Buffer.byteLength(text)), Buffer.from(text)])

/**
 * What the multiplayer screen does when someone clicks Join: a handshake for the address they
 * typed, then a login start. Answers how long the edge took to have a server for them, which is
 * the wait a player actually feels when a sleeping world wakes up. Any answer counts: this client
 * sends a placeholder protocol number, so the server's first packet is usually its polite "your
 * client is the wrong version" — which still only comes from a server that is up and reachable.
 */
export async function join(
  edge: Edge,
  address: string,
  name = 'SmokeTester',
  timeoutMs = 120_000,
): Promise<number> {
  const started = Date.now()
  const deadline = started + timeoutMs
  let last = 'never answered'
  // A player whose first attempt is dropped while the world is still loading clicks Join again;
  // so does this one. One attempt would measure the edge's patience, not the wait people feel.
  while (Date.now() < deadline) {
    try {
      await attempt(edge, address, name, Math.min(30_000, deadline - Date.now()))
      return Date.now() - started
    } catch (error) {
      last = (error as Error).message
      await Bun.sleep(2000)
    }
  }
  throw new Error(`${last} within ${timeoutMs / 1000}s`)
}

/** One connection: the handshake, the login, and whatever the server says back. */
function attempt(edge: Edge, address: string, name: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const fail = (why: string) => {
      socket.destroy()
      reject(new Error(why))
    }
    socket.setTimeout(timeoutMs, () => fail(`no answer in ${Math.round(timeoutMs / 1000)}s`))
    socket.connect(edge.port, edge.host, () => {
      const port = Buffer.alloc(2)
      port.writeUInt16BE(25565)
      socket.write(packet(0x00, Buffer.concat([varInt(770), mcString(address), port, varInt(2)])))
      socket.write(packet(0x00, Buffer.concat([mcString(name), Buffer.alloc(16)])))
    })
    let bytes = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk])
      for (let next = whole(bytes); next !== null; next = whole(bytes)) {
        // The edge's own notice turning a join away (restarting, still starting) is not the
        // server's answer: the player joins again, and so does this.
        const said = next.id === 0x00 ? next.body.toString('utf8') : ''
        if (said.includes('join again')) {
          fail(`the edge said ${said.replace(/^[^{"]*/, '')}`)
          return
        }
        // While a world wakes, the edge asks login queries to keep the client waiting. The game
        // answers that it didn't understand, and so does this; they are not the server's answer.
        if (next.id !== 0x04) {
          socket.destroy()
          resolve()
          return
        }
        const [messageId] = readVarInt(next.body, 0)
        socket.write(packet(0x02, Buffer.concat([varInt(messageId), Buffer.from([0])])))
        bytes = bytes.subarray(next.end)
      }
    })
    // The edge closes the connection when it gives up waiting for a world that is still loading.
    socket.once('close', () => reject(new Error('the edge closed the connection')))
    socket.on('error', (error) => fail(error.message))
  })
}

const readVarInt = (bytes: Buffer, at: number): [number, number] => {
  let value = 0
  let shift = 0
  let i = at
  for (;;) {
    const byte = bytes[i++]
    if (byte === undefined) throw new Error('short')
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [value, i]
    shift += 7
  }
}

/** The whole packet at the start of `bytes`: its id, its fields, and where it ends; null until it has all arrived. */
function whole(bytes: Buffer): { id: number; body: Buffer; end: number } | null {
  try {
    const [length, start] = readVarInt(bytes, 0)
    if (bytes.length < start + length) return null
    const [id, at] = readVarInt(bytes, start)
    return { id, body: bytes.subarray(at, start + length), end: start + length }
  } catch {
    return null
  }
}

/** One exchange through the edge: sends `first`, reads one whole packet back, closes. */
function exchange(
  edge: Edge,
  first: Buffer[],
  read: (id: number, body: Buffer) => unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    let bytes = Buffer.alloc(0)
    socket.setTimeout(30_000, () => {
      socket.destroy()
      reject(new Error('no answer in 30s'))
    })
    socket.connect(edge.port, edge.host, () => {
      for (const part of first) socket.write(part)
    })
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk])
      try {
        const [length, start] = readVarInt(bytes, 0)
        if (bytes.length < start + length) return
        const body = bytes.subarray(start, start + length)
        const [id, rest] = readVarInt(body, 0)
        socket.destroy()
        resolve(read(id, body.subarray(rest)))
      } catch {
        // More to come.
      }
    })
    socket.on('error', reject)
    socket.on('close', () => reject(new Error('closed without an answer')))
  })
}

const handshake = (address: string, protocol: number, next: number) => {
  const port = Buffer.alloc(2)
  port.writeUInt16BE(25565)
  return packet(0x00, Buffer.concat([varInt(protocol), mcString(address), port, varInt(next)]))
}

/**
 * The login start as the server's own version reads it: older servers drop a packet with bytes
 * they don't expect. Just the name up to 1.18.2 (758); 1.19 (759) asks whether a signing key
 * follows and 1.19.1 (760) whether a UUID does too, 1.19.3 to 1.20.1 (761–763) only the latter,
 * and from 1.20.2 (764) the UUID always follows.
 */
const hello = (name: string, protocol: number) => {
  const none = Buffer.from([0])
  const rest =
    protocol <= 758
      ? []
      : protocol === 759 || (protocol >= 761 && protocol <= 763)
        ? [none]
        : protocol === 760
          ? [none, none]
          : [Buffer.alloc(16)]
  return packet(0x00, Buffer.concat([mcString(name), ...rest]))
}

/** What the multiplayer screen's list shows of a server, as far as these scripts read it. */
interface Status {
  version: { name: string; protocol: number }
  players?: { online: number; max: number }
}

/** The status ping the multiplayer screen sends for each server in its list. */
async function status(edge: Edge, address: string): Promise<Status> {
  return (await exchange(edge, [handshake(address, 0, 1), packet(0x00, Buffer.alloc(0))], (_id, body) => {
    const [length, at] = readVarInt(body, 0)
    return JSON.parse(body.subarray(at, at + length).toString())
  })) as Status
}

/**
 * What the game's own client learns when it logs in, up to the server's first answer: whether the
 * server wants an account (it starts encryption), lets the player in, or turns them away and why.
 * Unlike `join`, it speaks the server's own protocol number, read from a status ping first, so the
 * answer is about the player rather than the version.
 */
export async function login(edge: Edge, address: string, name: string): Promise<string> {
  const { protocol } = (await status(edge, address)).version
  return (await exchange(edge, [handshake(address, protocol, 2), hello(name, protocol)], (id, body) => {
    if (id === 0x01) return 'wants an account'
    if (id === 0x02 || id === 0x03) return 'let in'
    const [length, at] = readVarInt(body, 0)
    return `turned away: ${body.subarray(at, at + length).toString()}`
  })) as string
}

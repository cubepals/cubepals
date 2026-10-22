// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the Bedrock check does as a Bedrock player does, from a machine that can send UDP: a RakNet
 * ping to the edge's port, a join by the headless client (`tools/bedrock-join`), and the Xbox user
 * ids behind the gamertags the access steps use.
 *
 * Not for the check's steps or its accounts (`scripts/bedrock-check.ts`).
 */
import { createSocket } from 'node:dgram'
import { lookup } from 'node:dns/promises'
import { SECOND_MS } from '@blockly/contracts/durations'

/** RakNet's offline-message marker, which every unconnected packet carries. */
const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex')
const UNCONNECTED_PING = 0x01
const UNCONNECTED_PONG = 0x1c

/** What a Bedrock client's server list shows of a server: the answer to RakNet's unconnected ping. */
export async function bedrockPing(host: string, port = 19132, timeoutMs = 5 * SECOND_MS): Promise<string> {
  const { address } = await lookup(host, { family: 4 })
  const ping = Buffer.concat([Buffer.from([UNCONNECTED_PING]), Buffer.alloc(8), MAGIC, Buffer.alloc(8)])
  const socket = createSocket('udp4')
  try {
    return await new Promise<string>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`no pong from ${address}:${port} in ${timeoutMs} ms`)),
        timeoutMs,
      )
      socket.on('error', fail)
      socket.on('message', (reply) => {
        if (reply[0] !== UNCONNECTED_PONG) return
        clearTimeout(timer)
        // Id, time, the server's guid and the magic come first, then the MOTD as a length-prefixed string.
        const at = 1 + 8 + 8 + MAGIC.length
        done(reply.subarray(at + 2, at + 2 + reply.readUInt16BE(at)).toString())
      })
      socket.send(ping, port, address)
    })
  } finally {
    socket.close()
  }
}

/** What one run of the headless client reported on its last line. */
export interface BedrockJoin {
  spawned: number
  spawnMs: (number | null)[]
  told: { kicked: string | null; chat: string[] }[]
  /** From starting the client to its exit, which includes the time it holds in the world. */
  tookMs: number
}

/**
 * Runs `tools/bedrock-join` against a play address, once with the options given. Its exit status
 * says whether every player spawned; a check that expects a refusal reads the answer instead.
 */
export async function bedrockJoin(
  address: string,
  options: string[] = [],
  signal?: AbortSignal,
): Promise<BedrockJoin> {
  const began = Date.now()
  const child = Bun.spawn(['bun', 'join.ts', '--address', address, ...options], {
    cwd: 'tools/bedrock-join',
    stdout: 'pipe',
    stderr: 'inherit',
    ...(signal === undefined ? {} : { signal }),
  })
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const last = out.trim().split('\n').at(-1) ?? ''
  if (!last.startsWith('{')) throw new Error(`the Bedrock client printed no result: ${last.slice(0, 200)}`)
  return { ...(JSON.parse(last) as Omit<BedrockJoin, 'tookMs'>), tookMs: Date.now() - began }
}

/** GeyserMC's Xbox lookup, which Cubepals itself asks to know a gamertag (apps/control/src/infra/geysermc). */
const XBOX_LOOKUP = 'https://api.geysermc.org/v2/xbox/xuid'

/**
 * The Xbox user id of each gamertag its cache knows, for the first `count` of `candidates` that it
 * does. Cubepals adds a Bedrock player to a list only through this lookup, so a test of the lists
 * needs gamertags that answer it.
 */
export async function knownGamertags(
  candidates: string[],
  count: number,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const gamertag of candidates) {
    if (found.size === count) break
    const response = await fetch(`${XBOX_LOOKUP}/${encodeURIComponent(gamertag)}`, {
      signal: AbortSignal.any([AbortSignal.timeout(10 * SECOND_MS), ...(signal ? [signal] : [])]),
    })
    const xuid = response.ok ? /"xuid"\s*:\s*"?(\d+)/.exec(await response.text())?.[1] : undefined
    if (xuid !== undefined) found.set(gamertag, xuid)
  }
  if (found.size < count) throw new Error(`GeyserMC knows only ${found.size} of ${candidates.join(', ')}`)
  return found
}

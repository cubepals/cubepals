// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A headless Bedrock join, for testing the edge's Geyser (apps/edge/bedrock.ts): PrismarineJS
 * bedrock-protocol logs in, spawns, says one line in chat and is counted. It reports how long each
 * player took to spawn.
 *
 *   bun tools/bedrock-join/join.ts --address <slug>.play.cubepals.com [--players 1] [--chat hello]
 *
 * --address   what a player types, host and optional port (19132). The Login carries it as the
 *             ServerAddress, and the edge routes by it.
 * --connect   where the packets go, when that isn't the address: an IPv4 and port. Defaults to
 *             the address.
 * --via6      host:port of an IPv6 UDP relay (a Fly machine's 6PN), reached through a forwarder on
 *             this machine. A Fly machine gets no UDP reply from a Fly app's public IPv4, so a
 *             test client running on Fly joins through the edge's private address instead.
 * --players   how many players join, one every --stagger ms (1500), each with a fake XUID of its
 *             own (--offset moves them): Floodgate makes a player's UUID from the XUID, so
 *             players sharing one would be refused as already logged in.
 * --username the gamertag to log in as, for one player (bedrock<n> otherwise), and --xuid the
 *             Xbox user id it carries (a made-up one otherwise). With sign-in off the edge takes
 *             both as given, so a test can be a real gamertag that a server's lists know.
 * --hold      seconds to stay in the world once everyone is in (10), then everyone leaves cleanly.
 * --timeout   seconds to wait for a player to spawn (240, a cold wake included). A connection not
 *             made within one attempt is tried again from a new socket until then.
 *
 * Offline login: there is no Xbox account here, so the edge must run with Xbox sign-in off
 * (BEDROCK_VALIDATE_LOGIN=false). Production keeps it on, and refuses these players.
 *
 * Prints one JSON object on the last line: how many spawned, each player's time to spawn, and each
 * player's kick message and the chat lines they were sent.
 * Exits 1 unless every player spawned. One machine's clients are the limit on how many players
 * it can join; run more than one machine for more.
 */

import { createSocket } from 'node:dgram'
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    address: { type: 'string' },
    connect: { type: 'string' },
    via6: { type: 'string' },
    players: { type: 'string', default: '1' },
    username: { type: 'string' },
    xuid: { type: 'string' },
    stagger: { type: 'string', default: '1500' },
    offset: { type: 'string', default: '0' },
    chat: { type: 'string', default: 'hello from a Bedrock player' },
    hold: { type: 'string', default: '10' },
    timeout: { type: 'string', default: '240' },
  },
})

const BEDROCK_PORT = 19132
const [typedHost = '', typedPort = String(BEDROCK_PORT)] = (values.address ?? '').split(':')
if (typedHost === '') {
  console.error('usage: join.ts --address <host[:port]> [--connect ip:port] [--via6 host:port] [--players n]')
  process.exit(2)
}
const count = Number(values.players)
const t0 = Date.now()
const log = (...parts: unknown[]) =>
  console.error(`[join +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)

/**
 * raknet-native looks its prebuilt binary up by the kernel's major version, and ships one built on
 * 5. The binary runs on later kernels, so a copy is named for this one.
 */
function ensureRaknetBinding(): void {
  const prebuilds = join(dirname(Bun.resolveSync('raknet-native/package.json', import.meta.dir)), 'prebuilds')
  const wanted = `${process.platform}-${release().split('.', 1)}-${process.arch}`
  if (existsSync(join(prebuilds, wanted))) return
  const same = readdirSync(prebuilds).find(
    (d) => d.startsWith(`${process.platform}-`) && d.endsWith(`-${process.arch}`),
  )
  if (same !== undefined) cpSync(join(prebuilds, same), join(prebuilds, wanted), { recursive: true })
}
ensureRaknetBinding()
const { createClient } = await import('bedrock-protocol')
// The package's types leave out Connecting, the status RakNet's connection moves a client to.
const { ClientStatus } = require('bedrock-protocol/src/connection.js') as {
  ClientStatus: { Disconnected: number }
}

/**
 * A UDP forwarder on this machine's loopback to an IPv6 address: bedrock-protocol's RakNet speaks
 * IPv4, and a Fly machine's private network is IPv6 only. One upstream socket per client port, so
 * the far end sees every client as its own peer.
 */
async function forwardTo6(target: string): Promise<number> {
  const colon = target.lastIndexOf(':')
  const host = target.slice(0, colon)
  const port = Number(target.slice(colon + 1))
  const front = createSocket('udp4')
  const upstreams = new Map<number, ReturnType<typeof createSocket>>()
  front.on('error', () => undefined)
  front.on('message', (message, from) => {
    let up = upstreams.get(from.port)
    if (up === undefined) {
      up = createSocket('udp6')
      up.on('error', () => undefined)
      up.on('message', (back) => front.send(back, from.port, from.address))
      upstreams.set(from.port, up)
    }
    up.send(message, port, host)
  })
  await new Promise<void>((resolve) => front.bind(0, '127.0.0.1', resolve))
  return front.address().port
}

const [connectHost, connectPort] = (values.connect ?? '').split(':')
let to = { host: connectHost || typedHost, port: Number(connectPort ?? typedPort) }
if (values.via6) to = { host: '127.0.0.1', port: await forwardTo6(values.via6) }

const spawnMs: (number | null)[] = []
const clients: { disconnect: () => void }[] = []
/** What each player was told: the reason they were turned away, and the chat lines that reached them. */
const told: { kicked: string | null; chat: string[] }[] = []
let spawned = 0

/**
 * How long one RakNet connection attempt lasts: raknet-native sends twelve open requests half a
 * second apart, then gives up without a word, and its client waits out the whole --timeout.
 */
const ATTEMPT_MS = 10_000

function join1(index: number): Promise<void> {
  const n = index + Number(values.offset)
  const username = values.username ?? `bedrock${n}`
  const begun = Date.now()
  const deadline = begun + Number(values.timeout) * 1000
  spawnMs[index] = null
  const heard = { kicked: null as string | null, chat: [] as string[] }
  told[index] = heard
  return new Promise((resolve) => {
    let ended = false
    const end = () => {
      ended = true
      resolve()
    }
    const attempt = () => {
      const client = createClient({
        host: to.host,
        port: to.port,
        username,
        offline: true,
        raknetBackend: 'raknet-native' as const,
        skipPing: true,
        connectTimeout: deadline - Date.now(),
      })
      clients[index] = client
      // The Login is built after the socket opens, from the client's own copy of the options, so
      // naming the typed address now puts it in the ServerAddress without it being where the
      // packets already go.
      client.options.host = typedHost
      client.options.port = Number(typedPort)
      // Offline logins carry XUID 0, and Floodgate makes its UUID from the XUID.
      if (client.profile)
        client.profile.xuid = values.xuid === undefined ? 2535400000000000 + n : Number(values.xuid)
      client.on('join', () => log(username, 'logged in'))
      client.on('spawn', () => {
        spawnMs[index] = Date.now() - begun
        spawned++
        log(username, `spawned after ${spawnMs[index]} ms (${spawned}/${count})`)
        client.queue('text', {
          type: 'chat',
          needs_translation: false,
          category: 'authored',
          source_name: username,
          xuid: '',
          platform_chat_id: '',
          filtered_message: '',
          message: values.chat,
        })
        end()
      })
      client.on('text', (p: { message?: string }) => {
        log(username, 'chat:', p.message)
        heard.chat.push(p.message ?? '')
      })
      client.on('kick', (p: { message?: string }) => {
        log(username, 'kicked:', JSON.stringify(p))
        heard.kicked = p.message ?? JSON.stringify(p)
        end()
      })
      client.on('error', (e: Error) => {
        log(username, 'error:', e.message)
        end()
      })
      // A path through the network can lose every datagram of one socket while another socket's
      // get through, so an attempt that never connected is let go and a new socket tries again, as
      // a player taps Join again.
      setTimeout(() => {
        if (ended || client.status !== ClientStatus.Disconnected || Date.now() + ATTEMPT_MS > deadline) return
        log(username, `not connected after ${ATTEMPT_MS / 1000}s; trying again from a new socket`)
        client.close()
        attempt()
      }, ATTEMPT_MS)
    }
    attempt()
    setTimeout(end, deadline - Date.now())
  })
}

const joining: Promise<void>[] = []
for (let i = 0; i < count; i++) {
  joining.push(join1(i))
  await Bun.sleep(Number(values.stagger))
}
await Promise.all(joining)
await Bun.sleep(Number(values.hold) * 1000)
// Leaving as a player does, so the server drops the session now rather than when its connection
// times out: a player who joins again at once is not told they are already logged in.
for (const client of clients) client.disconnect()
await Bun.sleep(1000)
process.stdout.write(`${JSON.stringify({ players: count, spawned, spawnMs, told })}\n`)
process.exit(spawned === count ? 0 : 1)

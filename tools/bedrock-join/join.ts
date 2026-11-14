// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A headless Bedrock join over NetherNet, the way Bedrock players join a server by address, for
 * testing the edge's Geyser (apps/edge/bedrock.ts): JSPrismarine's client signals over HTTPS on
 * TCP 19132, plays over WebRTC, logs in, spawns, says one line in chat and is counted. It reports
 * how long each player took to spawn.
 *
 *   bun tools/bedrock-join/join.ts --address <slug>.play.cubepals.com [--players 1] [--chat hello]
 *
 * --address   what a player types, host and optional port (19132). Signaling asks that name, and
 *             the Login carries it as the ServerAddress, which the edge routes by.
 * --players   how many players join, one every --stagger ms (1500), each with a fake XUID of its
 *             own (--offset moves them): Floodgate makes a player's UUID from the XUID, so
 *             players sharing one would be refused as already logged in.
 * --username the gamertag to log in as, for one player (bedrock<n> otherwise), and --xuid the
 *             Xbox user id it carries (a made-up one otherwise). With sign-in off the edge takes
 *             both as given, so a test can be a real gamertag that a server's lists know.
 * --hold      seconds to stay in the world once everyone is in (10), then everyone leaves cleanly.
 *             A player turned out meanwhile is reported with the reason they were given.
 * --timeout   seconds to wait for a player to spawn (240, a cold wake included).
 * --signaling where signaling is asked, when that isn't https://<address>: an origin such as
 *             http://10.0.0.5:19145, for a Geyser run by hand with its built-in signaling.
 *
 * The client signals over plain HTTP, so it is pointed at a door on this machine that asks the
 * edge over HTTPS (`signaling-forwarder.ts`). The game then goes straight to the address the edge's
 * answer names. It speaks protocol 2225 (Bedrock 26.60), the first that joins only this way, and
 * signs its offer with its login's own key, as the game does.
 *
 * Offline login: there is no Xbox account here, so the edge must run with Xbox sign-in off
 * (BEDROCK_VALIDATE_LOGIN=false). Production keeps it on, and refuses these players.
 *
 * Prints one JSON object on the last line: how many spawned, each player's time
 * to spawn, how many attempts each made (one: a NetherNet join is one request and one connection),
 * and each player's kick message and the chat lines they were sent. Exits 1 unless every player
 * spawned.
 */

import { createPrivateKey } from 'node:crypto'
import { parseArgs } from 'node:util'
import Client from '@jsprismarine/client'
import NetherNetTransport from '@jsprismarine/client/net/NetherNetTransport'
import { NetherNetIdentity } from '@jsprismarine/nethernet'
import { PacketIdentifier, TextPacket, TextPacketType } from '@jsprismarine/protocol'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { signalingForwarder } from './signaling-forwarder.ts'

const { values } = parseArgs({
  options: {
    address: { type: 'string' },
    players: { type: 'string', default: '1' },
    username: { type: 'string' },
    xuid: { type: 'string' },
    stagger: { type: 'string', default: '1500' },
    offset: { type: 'string', default: '0' },
    chat: { type: 'string', default: 'hello from a Bedrock player' },
    hold: { type: 'string', default: '10' },
    timeout: { type: 'string', default: '240' },
    signaling: { type: 'string' },
  },
})

const BEDROCK_PORT = 19132
/** Bedrock 26.60's protocol: the first release that no longer joins over RakNet. */
const PROTOCOL = 2225
/** The XUIDs made-up players carry: one per player, from the offset. */
const FIRST_XUID = 2535400000000000

const [typedHost = '', typedPort = String(BEDROCK_PORT)] = (values.address ?? '').split(':')
if (typedHost === '') {
  console.error('usage: join.ts --address <host[:port]> [--players n] [--username name] [--hold s]')
  process.exit(2)
}
const count = Number(values.players)
const timeoutMs = Number(values.timeout) * SECOND_MS
const t0 = Date.now()
const log = (...parts: unknown[]) =>
  console.error(`[nethernet +${((Date.now() - t0) / SECOND_MS).toFixed(1)}s]`, ...parts)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The part of the client's own login identity this join reaches past its types for. */
interface OwnAuth {
  identity: { xuid: string; displayName: string }
  getIdentityPrivateKey(): Promise<string>
}
const authOf = (client: Client) => (client as unknown as { auth: OwnAuth }).auth

const door = signalingForwarder(values.signaling ?? `https://${typedHost}:${typedPort}`)

/** A client for one player: signaling through the door, the Login naming the typed address. */
function clientFor(username: string, xuid: string): Client {
  let made: Client | null = null
  // The offer is signed with the login's own key, as the game signs it: Geyser refuses a login
  // whose key isn't the one the connection was admitted with, and the client's default for an
  // offline player is a fresh key of its own.
  const transport = new NetherNetTransport({
    host: '127.0.0.1',
    port: door.port,
    timeoutMs,
    identity: async () => {
      if (made === null) return undefined
      const key = createPrivateKey(await authOf(made).getIdentityPrivateKey())
      return new NetherNetIdentity(key, { keyFormat: 'der' })
    },
  })
  made = new Client({
    host: typedHost,
    port: Number(typedPort),
    displayName: username,
    transport,
    protocolVersion: PROTOCOL,
    loginTimeoutMs: timeoutMs,
  })
  // An offline identity carries no XUID, and Floodgate makes its UUID from the XUID. It is read
  // when the login is signed.
  authOf(made).identity.xuid = xuid
  return made
}

const spawnMs: (number | null)[] = []
const attempts: number[] = []
const clients: Client[] = []
/** What each player was told: the reason they were turned away, and the chat lines that reached them. */
const told: { kicked: string | null; chat: string[] }[] = []
let spawned = 0

async function join1(index: number): Promise<void> {
  const n = index + Number(values.offset)
  const username = values.username ?? `bedrock${n}`
  const xuid = values.xuid ?? String(FIRST_XUID + n)
  const heard = { kicked: null as string | null, chat: [] as string[] }
  told[index] = heard
  spawnMs[index] = null
  attempts[index] = 1
  const client = clientFor(username, xuid)
  clients[index] = client
  client.on('packet', (packet: { id: number; data: unknown }) => {
    if (packet.id === PacketIdentifier.TEXT) {
      const message = (packet.data as { message?: string }).message ?? ''
      log(username, 'chat:', message)
      heard.chat.push(message)
    } else if (packet.id === PacketIdentifier.DISCONNECT) {
      heard.kicked = (packet.data as { message?: string }).message ?? 'no reason given'
      log(username, 'kicked:', heard.kicked)
    }
  })
  const begun = Date.now()
  try {
    await client.connect()
  } catch (error) {
    heard.kicked ??= (error as Error).message
    log(username, 'did not spawn:', heard.kicked)
    return
  }
  spawnMs[index] = Date.now() - begun
  spawned++
  log(username, `spawned after ${spawnMs[index]} ms (${spawned}/${count})`)
  await client.getSession().send(
    new TextPacket({
      type: TextPacketType.Chat,
      needsTranslation: false,
      sourceName: username,
      message: values.chat,
      xuid,
      platformChatId: '',
      filtered: '',
    }),
  )
}

const joining: Promise<void>[] = []
for (let i = 0; i < count; i++) {
  joining.push(join1(i))
  await pause(Number(values.stagger))
}
await Promise.all(joining)
await pause(Number(values.hold) * SECOND_MS)
// Leaving as a player does, so the server drops the session now rather than when it times out: a
// player who joins again at once is not told they are already logged in.
for (const client of clients) client.disconnect()
await pause(SECOND_MS)
door.close()
process.stdout.write(`${JSON.stringify({ players: count, spawned, spawnMs, attempts, told })}\n`)
process.exit(spawned === count ? 0 : 1)

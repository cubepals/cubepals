// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bedrock players on the edge: one Geyser, supervised here, translating each to a Java player who
 * dials this edge's own front door with the name the Bedrock player typed, so routing, the hold and
 * wake-on-join are the Java path's, unchanged. Fly never starts a stopped machine for UDP, which is
 * why this lives on the always-on edge and not on any server. Bedrock joins two ways:
 *
 * - NetherNet (Bedrock 26.60 and later, the only way they join): a player's client asks Geyser's
 *   signaling over HTTPS on TCP `port` (Fly ends TLS with the play domain's certificate and hands
 *   it to the agent's door on `signalingPort`, which passes it to Geyser), then plays over WebRTC on
 *   UDP `webrtcPort`, at the edge's public IPv4, straight to Geyser on the address Fly hands UDP to. The identity signaling signs with is the
 *   same on every edge (`nethernet-identity.ts`), since clients pin it.
 * - RakNet (older clients): on UDP `port`, through the relay (`bedrock-relay.ts`).
 *
 * Left out where there is no Floodgate key: the edge then takes Java players only. Bedrock never
 * takes Java down with it: Geyser restarts alone, the relay's bind is tried again until it holds,
 * and how it all stands is its own status (`status`), apart from the edge's health.
 */

import { lookup } from 'node:dns/promises'
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { bedrockRelay, type Relay } from './bedrock-relay.ts'
import { pipe } from './front.ts'
import { Supervised } from './geyser.ts'
import { geyserConfig } from './geyser-config.ts'
import type { Rate } from './limits.ts'
import { bedrockOpened } from './metrics.ts'
import { nethernetIdentity } from './nethernet-identity.ts'

export interface BedrockOptions {
  /** The Floodgate key: base64 of 16 bytes, the same on every Paper server (FLOODGATE_KEY). */
  key: string
  /** Where Geyser's jar is, and the folder it may write in. */
  jar: string
  dir: string
  /**
   * What Geyser fetches from Mojang on its first start (its `cache` and `locales`), baked into the
   * image: copied into `dir` first, so a start doesn't wait on a download.
   */
  warm: string
  heap: string
  /** The name Fly's UDP is reached by on this machine (`fly-global-services`), or an address. */
  bind: string
  /** The port players join: RakNet over UDP through the relay, and NetherNet's signaling over TCP. */
  port: number
  /**
   * The agent's door for NetherNet's signaling, on every address: Fly's proxy ends TLS on `port` over
   * TCP and connects here, and the door passes each connection to Geyser's own signaling.
   */
  signalingPort: number
  /** The UDP port NetherNet's game runs on, the same inside and out, as Fly doesn't rewrite UDP ports. */
  webrtcPort: number
  /** A name that resolves to the edge's public IPv4, which NetherNet tells players to reach; null for none. */
  advertise: string | null
  /** The edge's front door for Geyser (`front.ts`), which it dials for every player. */
  front: number
  validateLogin: boolean
  /** Pongs one address is sent, and pongs sent in all. */
  pongs: Rate
  totalPongs: Rate
  opens: Rate
  /** Players one address (an IPv6 one by its /64) may hold at once. */
  perAddress: number
  most: number
}

/**
 * The settings the agent's environment gives; null without a Floodgate key, which leaves Bedrock
 * players out. Limits are counted per address, as `limits.ts`'s are.
 */
export function bedrockFromEnv(env: NodeJS.ProcessEnv, front: number): BedrockOptions | null {
  if (!env.FLOODGATE_KEY) return null
  const number = (name: string, fallback: number) => Number(env[name] ?? fallback)
  return {
    key: env.FLOODGATE_KEY,
    jar: env.GEYSER_JAR ?? '/geyser/Geyser-Standalone.jar',
    dir: env.GEYSER_DIR ?? '/tmp/geyser',
    warm: env.GEYSER_WARM ?? '/geyser/warm',
    heap: env.GEYSER_HEAP ?? '768m',
    bind: env.BEDROCK_BIND ?? 'fly-global-services',
    port: number('BEDROCK_PORT', 19132),
    signalingPort: number('BEDROCK_SIGNALING_PORT', 19134),
    webrtcPort: number('BEDROCK_WEBRTC_PORT', 19133),
    advertise: env.BEDROCK_ADVERTISE ?? advertisedName(env.PLAY_DOMAINS),
    front,
    // On unless a test edge says otherwise: a test edge's clients have no Xbox account.
    validateLogin: env.BEDROCK_VALIDATE_LOGIN !== 'false',
    pongs: { perSecond: number('BEDROCK_PONGS_PER_SECOND', 2), burst: number('BEDROCK_PONGS_BURST', 10) },
    totalPongs: {
      perSecond: number('BEDROCK_TOTAL_PONGS_PER_SECOND', 200),
      burst: number('BEDROCK_TOTAL_PONGS_BURST', 400),
    },
    opens: { perSecond: number('BEDROCK_OPENS_PER_SECOND', 1), burst: number('BEDROCK_OPENS_BURST', 10) },
    perAddress: number('BEDROCK_ADDRESS_PLAYERS', 32),
    most: number('BEDROCK_MOST_PLAYERS', 2000),
  }
}

/**
 * The name looked up for the edge's public address: any name under a play domain's wildcard
 * records is the edge's, so this one needs no record of its own.
 */
export function advertisedName(playDomains: string | undefined): string | null {
  const domain = (playDomains ?? '').split(',')[0]?.trim()
  return domain ? `bedrock.${domain}` : null
}

/** The port Geyser's RakNet listens on, behind the relay: no service of Fly's exposes it. */
const GEYSER_PORT = 19131
/**
 * The port Geyser's signaling listens on. Geyser listens on Fly's UDP address alone, which Fly's
 * proxy doesn't connect to, so it is reached only through the agent's door (`signalingPort`).
 */
const GEYSER_SIGNALING_PORT = 19135
/**
 * How long the door keeps a signaling connection that has gone quiet both ways: far longer than a
 * signaling exchange, so only one left behind is closed.
 */
const SIGNALING_IDLE_MS = 10 * MINUTE_MS
/**
 * Where Fly's proxy connects from, which built-in signaling trusts to name the player in
 * X-Forwarded-For: private addresses only, which nothing on the internet can be.
 */
const FLY_PROXY = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']
/**
 * How long Geyser keeps a source's PROXY header while nothing comes from it: SESSION_TIMEOUT_MS of
 * its RakNet library (org.cloudburstmc.netty's RakConstants), which nothing outside Java exports.
 */
const GEYSER_KEEPS_QUIET_SOURCE_MS = 10 * SECOND_MS
/** The most the key may be: Floodgate's is AES-128, 16 bytes. */
const KEY_BYTES = 16
/** What Geyser's process is given of the agent's environment: enough to find Java, and nothing secret. */
const GEYSER_ENV = ['PATH', 'JAVA_HOME', 'LANG', 'LC_ALL', 'TZ']

/** The environment Geyser runs in: only `GEYSER_ENV`'s names, so the key and tokens stay in the agent. */
export function geyserEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    GEYSER_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  )
}

/** Where Bedrock stands, by itself: Java's health never depends on it. */
interface BedrockStatus {
  /** `up` when Geyser runs and has answered the relay; `starting` before it first has; else `down`. */
  state: 'starting' | 'up' | 'down'
  /** Whether the relay holds its UDP socket. */
  bound: boolean
  restarts: number
}

export interface Bedrock {
  status: () => BedrockStatus
  stop: () => void
}

/** Where Geyser listens, and the public address NetherNet players are sent to, as looked up at start. */
export interface GeyserPlace {
  address: string
  /** The edge's public IPv4, or null where it has none to give. */
  publicAddress: string | null
}

/** Writes `contents` readable by this user alone, as Geyser's secrets must be. */
function writePrivate(file: string, contents: string | Uint8Array): void {
  writeFileSync(file, contents, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/**
 * Writes Geyser's folder: what it fetched at build, the key and NetherNet's identity (readable by
 * this user alone), its config.
 */
export function prepareGeyserDir(options: BedrockOptions, place: GeyserPlace): void {
  const key = Buffer.from(options.key, 'base64')
  if (key.length !== KEY_BYTES) throw new Error(`FLOODGATE_KEY must be base64 of ${KEY_BYTES} bytes`)
  mkdirSync(join(options.dir, 'nethernet'), { recursive: true })
  if (existsSync(options.warm)) cpSync(options.warm, options.dir, { recursive: true })
  writePrivate(join(options.dir, 'key.pem'), key)
  writePrivate(join(options.dir, 'nethernet', 'identity.pem'), nethernetIdentity(key))
  writeFileSync(
    join(options.dir, 'config.yml'),
    geyserConfig({
      bedrock: { address: place.address, port: GEYSER_PORT },
      nethernet: {
        webrtcPort: options.webrtcPort,
        advertise: place.publicAddress === null ? [] : [`${place.publicAddress}:${options.webrtcPort}`],
        trustedProxies: FLY_PROXY,
      },
      publicPort: options.port,
      java: { address: '127.0.0.1', port: options.front },
      keyFile: 'key.pem',
      validateLogin: options.validateLogin,
      mtu: 1300,
    }),
  )
}

/** Tries `attempt` until it holds, waiting longer after each failure up to `longest`; each failure is reported. */
export async function untilItHolds<T>(
  attempt: () => Promise<T>,
  failed: (error: unknown) => void,
  stopped: () => boolean,
  firstMs = SECOND_MS,
  longestMs = 30 * SECOND_MS,
): Promise<T | null> {
  for (let wait = firstMs; !stopped(); wait = Math.min(wait * 2, longestMs)) {
    try {
      return await attempt()
    } catch (error) {
      failed(error)
      await Bun.sleep(wait)
    }
  }
  return null
}

/**
 * The door Fly's proxy hands NetherNet's signaling to, on every address: each connection is passed
 * to Geyser's own signaling at `geyser`, as it came, the player named by Fly in X-Forwarded-For.
 */
export async function signalingDoor(port: number, geyser: string): Promise<Server> {
  const door = createServer((client) => {
    pipe(client, geyser, new Uint8Array(0), { connectMs: 5 * SECOND_MS, idleMs: SIGNALING_IDLE_MS })
  })
  await new Promise<void>((listening, failed) => {
    door.once('error', failed)
    door.listen(port, '0.0.0.0', () => {
      door.off('error', failed)
      listening()
    })
  })
  door.on('error', (error) => console.error('[geyser] the NetherNet signaling door failed', error))
  return door
}

/**
 * The public IPv4 behind `name`, which NetherNet players are told to reach. Null without a name,
 * or when it doesn't resolve: Java's path and RakNet players never depend on it.
 */
async function publicAddressOf(name: string | null): Promise<string | null> {
  if (name === null) return null
  try {
    return (await lookup(name, { family: 4 })).address
  } catch (error) {
    console.error(`[geyser] ${name} did not resolve`, error)
    return null
  }
}

/**
 * Starts Geyser, supervised, the relay in front of it and NetherNet's signaling door. Returns at
 * once: Geyser listens on Fly's UDP address, which may not be there yet, so finding it, starting
 * Geyser and the relay's and the door's binds are tried again in the background until they hold,
 * and never make the caller wait or fail. A wrong key is the one thing that fails here, as nothing would ever fix it.
 */
export function startBedrock(options: BedrockOptions): Bedrock {
  if (Buffer.from(options.key, 'base64').length !== KEY_BYTES)
    throw new Error(`FLOODGATE_KEY must be base64 of ${KEY_BYTES} bytes`)
  if (!options.validateLogin) console.error('[geyser] XBOX SIGN-IN IS OFF: for a test edge only')

  let relay: Relay | null = null
  let geyser: Supervised | null = null
  let door: Server | null = null
  let stopped = false
  const startGeyser = (place: GeyserPlace): Supervised => {
    prepareGeyserDir(options, place)
    const supervised = new Supervised({
      command: [
        'java',
        `-Xmx${options.heap}`,
        '-XX:+UseSerialGC',
        '-XX:+ExitOnOutOfMemoryError',
        // Signaling on a port of its own, reached through the agent's door: the public one is Fly's proxy's.
        `-DgeyserSignalingPort=${GEYSER_SIGNALING_PORT}`,
        '-jar',
        options.jar,
        '--nogui',
      ],
      cwd: options.dir,
      env: geyserEnv(process.env),
      prefix: '[geyser]',
      // The Geyser that starts next knows no player and has given no pong.
      exited: () => relay?.forget(),
    })
    void supervised.run()
    return supervised
  }

  void untilItHolds(
    async () => {
      const address = (await lookup(options.bind, { family: 4 })).address
      if (geyser === null) {
        const publicAddress = await publicAddressOf(options.advertise)
        geyser = startGeyser({ address, publicAddress })
        console.error(
          publicAddress === null
            ? "[geyser] no public address to give: NetherNet players can't reach this edge"
            : `[geyser] NetherNet players play at ${publicAddress}:${options.webrtcPort}`,
        )
      }
      if (relay === null) {
        relay = await bedrockRelay({
          bind: { hostname: address, port: options.port },
          geyser: { hostname: address, port: GEYSER_PORT },
          pongs: options.pongs,
          totalPongs: options.totalPongs,
          opens: options.opens,
          perAddress: options.perAddress,
          most: options.most,
          opened: bedrockOpened,
          idleMs: GEYSER_KEEPS_QUIET_SOURCE_MS - 2 * SECOND_MS,
          pongRefreshMs: 5 * SECOND_MS,
        })
        console.error(`[geyser] Bedrock players join at ${address}:${options.port}`)
      }
      // After the relay, so a door that can't open yet never keeps RakNet players out.
      door ??= await signalingDoor(options.signalingPort, `${address}:${GEYSER_SIGNALING_PORT}`)
    },
    (error) => console.error('[geyser] the Bedrock port could not be opened; trying again', error),
    () => stopped,
  )
  let answered = false
  return {
    status() {
      const up = geyser?.state === 'running' && relay?.ready() === true && door?.listening === true
      answered ||= up
      return {
        state: up ? 'up' : answered ? 'down' : 'starting',
        bound: relay !== null,
        restarts: geyser?.restarts ?? 0,
      }
    },
    stop() {
      stopped = true
      geyser?.stop()
      relay?.close()
      door?.close()
    },
  }
}

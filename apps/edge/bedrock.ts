// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bedrock players on the edge: one Geyser, supervised here, translating each to a Java player who
 * dials this edge's own front door with the name the Bedrock player typed, so routing, the hold and
 * wake-on-join are the Java path's, unchanged. Players reach it on UDP through the relay
 * (`bedrock-relay.ts`), bound to the address Fly hands UDP to. Fly never starts a stopped machine
 * for UDP, which is why this lives on the always-on edge and not on any server.
 *
 * Left out where there is no Floodgate key: the edge then takes Java players only. Bedrock never
 * takes Java down with it: Geyser restarts alone, the relay's bind is tried again until it holds,
 * and how it all stands is its own status (`status`), apart from the edge's health.
 */

import { lookup } from 'node:dns/promises'
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { bedrockRelay, type Relay } from './bedrock-relay.ts'
import { Supervised } from './geyser.ts'
import { geyserConfig } from './geyser-config.ts'
import type { Rate } from './limits.ts'

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
  port: number
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

/** The port Geyser listens on, on loopback, behind the relay. */
const GEYSER_PORT = 19131
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

/** Writes Geyser's folder: what it fetched at build, the key (readable by this user alone), its config. */
export function prepareGeyserDir(options: BedrockOptions): void {
  const key = Buffer.from(options.key, 'base64')
  if (key.length !== KEY_BYTES) throw new Error(`FLOODGATE_KEY must be base64 of ${KEY_BYTES} bytes`)
  mkdirSync(options.dir, { recursive: true })
  if (existsSync(options.warm)) cpSync(options.warm, options.dir, { recursive: true })
  const keyFile = join(options.dir, 'key.pem')
  writeFileSync(keyFile, key, { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  writeFileSync(
    join(options.dir, 'config.yml'),
    geyserConfig({
      bedrock: { address: '127.0.0.1', port: GEYSER_PORT },
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
 * Starts Geyser, supervised, and the relay in front of it. Returns once the folder is written: the
 * relay's bind, which can fail (Fly's UDP address isn't there yet), is tried again in the
 * background until it holds, and never makes the caller wait or fail.
 */
export function startBedrock(options: BedrockOptions): Bedrock {
  prepareGeyserDir(options)
  if (!options.validateLogin) console.error('[geyser] XBOX SIGN-IN IS OFF: for a test edge only')

  let relay: Relay | null = null
  const geyser = new Supervised({
    command: [
      'java',
      `-Xmx${options.heap}`,
      '-XX:+UseSerialGC',
      '-XX:+ExitOnOutOfMemoryError',
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
  void geyser.run()

  let stopped = false
  void untilItHolds(
    async () => {
      const hostname = (await lookup(options.bind, { family: 4 })).address
      relay = await bedrockRelay({
        bind: { hostname, port: options.port },
        geyser: { hostname: '127.0.0.1', port: GEYSER_PORT },
        pongs: options.pongs,
        totalPongs: options.totalPongs,
        opens: options.opens,
        perAddress: options.perAddress,
        most: options.most,
        idleMs: GEYSER_KEEPS_QUIET_SOURCE_MS - 2 * SECOND_MS,
        pongRefreshMs: 5 * SECOND_MS,
      })
      console.error(`[geyser] Bedrock players join at ${hostname}:${options.port}`)
    },
    (error) => console.error('[geyser] the Bedrock port could not be opened; trying again', error),
    () => stopped,
  )
  let answered = false
  return {
    status() {
      const up = geyser.state === 'running' && relay?.ready() === true
      answered ||= up
      return {
        state: up ? 'up' : answered ? 'down' : 'starting',
        bound: relay !== null,
        restarts: geyser.restarts,
      }
    },
    stop() {
      stopped = true
      geyser.stop()
      relay?.close()
    },
  }
}

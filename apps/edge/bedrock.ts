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
 * Left out where there is no Floodgate key: the edge then takes Java players only.
 */

import { lookup } from 'node:dns/promises'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { bedrockRelay } from './bedrock-relay.ts'
import { Supervised } from './geyser.ts'
import { geyserConfig } from './geyser-config.ts'
import type { Rate } from './limits.ts'

export interface BedrockOptions {
  /** The Floodgate key: base64 of 16 bytes, the same on every Paper server (FLOODGATE_KEY). */
  key: string
  /** Where Geyser's jar is, and the folder it may write in. */
  jar: string
  dir: string
  heap: string
  /** The name Fly's UDP is reached by on this machine (`fly-global-services`), or an address. */
  bind: string
  port: number
  /** The edge's front door, which Geyser dials for every player. */
  front: number
  validateLogin: boolean
  pongs: Rate
  opens: Rate
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
    heap: env.GEYSER_HEAP ?? '512m',
    bind: env.BEDROCK_BIND ?? 'fly-global-services',
    port: number('BEDROCK_PORT', 19132),
    front,
    // On unless a test edge says otherwise: a test edge's clients have no Xbox account.
    validateLogin: env.BEDROCK_VALIDATE_LOGIN !== 'false',
    pongs: { perSecond: number('BEDROCK_PONGS_PER_SECOND', 2), burst: number('BEDROCK_PONGS_BURST', 10) },
    opens: { perSecond: number('BEDROCK_OPENS_PER_SECOND', 1), burst: number('BEDROCK_OPENS_BURST', 10) },
    most: number('BEDROCK_MOST_PLAYERS', 2000),
  }
}

/** The port Geyser listens on, on loopback, behind the relay. */
const GEYSER_PORT = 19131
/** The most the key may be: Floodgate's is AES-128, 16 bytes. */
const KEY_BYTES = 16

export interface Bedrock {
  /** Whether Geyser is up and has answered the relay: false while it starts and while it restarts. */
  healthy: () => boolean
  stop: () => void
}

/** Writes Geyser's folder and starts it with the relay in front of it. */
export async function startBedrock(options: BedrockOptions): Promise<Bedrock> {
  const key = Buffer.from(options.key, 'base64')
  if (key.length !== KEY_BYTES) throw new Error(`FLOODGATE_KEY must be base64 of ${KEY_BYTES} bytes`)
  mkdirSync(options.dir, { recursive: true })
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
  if (!options.validateLogin) console.error('[geyser] XBOX SIGN-IN IS OFF: for a test edge only')

  const geyser = new Supervised({
    command: ['java', `-Xmx${options.heap}`, '-XX:+UseSerialGC', '-jar', options.jar, '--nogui'],
    cwd: options.dir,
    prefix: '[geyser]',
  })
  void geyser.run()

  const hostname = (await lookup(options.bind, { family: 4 })).address
  const relay = await bedrockRelay({
    bind: { hostname, port: options.port },
    geyser: { hostname: '127.0.0.1', port: GEYSER_PORT },
    pongs: options.pongs,
    opens: options.opens,
    most: options.most,
    idleMs: 30 * SECOND_MS,
    pongRefreshMs: 5 * SECOND_MS,
  })
  console.error(`[geyser] Bedrock players join at ${hostname}:${options.port}`)
  return {
    healthy: () => geyser.state === 'running' && relay.ready(),
    stop() {
      geyser.stop()
      relay.close()
    },
  }
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Bedrock on the edge: what Geyser is given to run on, how its folder is written, and the retried bind. */

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BedrockOptions, bedrockFromEnv, geyserEnv, prepareGeyserDir, untilItHolds } from './bedrock.ts'

test('without a Floodgate key the edge takes Java players only', () => {
  expect(bedrockFromEnv({}, 25565)).toBeNull()
})

test('Xbox sign-in stays on unless a test edge turns it off', () => {
  const key = Buffer.alloc(16).toString('base64')
  expect(bedrockFromEnv({ FLOODGATE_KEY: key }, 25565)?.validateLogin).toBe(true)
  expect(bedrockFromEnv({ FLOODGATE_KEY: key, BEDROCK_VALIDATE_LOGIN: 'false' }, 25565)?.validateLogin).toBe(
    false,
  )
  expect(bedrockFromEnv({ FLOODGATE_KEY: key, BEDROCK_PORT: '19140' }, 25570)).toMatchObject({
    port: 19140,
    front: 25570,
  })
})

const KEY = Buffer.alloc(16, 7).toString('base64')

test('Geyser is given only what it needs to run, none of the agent’s secrets', () => {
  const env = geyserEnv({
    PATH: '/usr/bin',
    JAVA_HOME: '/opt/java',
    LANG: 'C.UTF-8',
    FLOODGATE_KEY: KEY,
    EDGE_TOKEN: 'token',
    CONTROL_URL: 'http://control.internal',
    WEB_CANONICAL_ORIGIN: 'https://example.test',
  })
  expect(env).toEqual({ PATH: '/usr/bin', JAVA_HOME: '/opt/java', LANG: 'C.UTF-8' })
})

test('its folder gets what was fetched at build, the key for this user alone, and its config', () => {
  const root = mkdtempSync(join(tmpdir(), 'geyser-'))
  const warm = join(root, 'warm')
  mkdirSync(join(warm, 'cache'), { recursive: true })
  writeFileSync(join(warm, 'cache', 'client_jar.hash'), 'abc')
  const dir = join(root, 'run')
  const options = {
    ...(bedrockFromEnv({ FLOODGATE_KEY: KEY, GEYSER_DIR: dir, GEYSER_WARM: warm }, 25570) as BedrockOptions),
  }
  prepareGeyserDir(options)
  expect(readFileSync(join(dir, 'cache', 'client_jar.hash'), 'utf8')).toBe('abc')
  expect(Buffer.from(readFileSync(join(dir, 'key.pem'))).toString('base64')).toBe(KEY)
  expect(statSync(join(dir, 'key.pem')).mode & 0o777).toBe(0o600)
  expect(readFileSync(join(dir, 'config.yml'), 'utf8')).toContain('port: 25570')
  expect(() => prepareGeyserDir({ ...options, key: 'AAAA' })).toThrow('16 bytes')
})

test('a bind that fails is tried again until it holds, and never gives up on its own', async () => {
  let tries = 0
  const failures: unknown[] = []
  const held = await untilItHolds(
    async () => {
      if (++tries < 3) throw new Error('no address yet')
      return 'bound'
    },
    (error) => failures.push(error),
    () => false,
    1,
    2,
  )
  expect(held).toBe('bound')
  expect(failures).toHaveLength(2)
  // Stopped, it stops trying.
  expect(
    await untilItHolds(
      async () => 'x',
      () => {},
      () => true,
    ),
  ).toBeNull()
})

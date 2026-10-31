// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Bedrock on the edge: what Geyser is given to run on, how its folder is written, and the retried bind. */

import { expect, test } from 'bun:test'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { type AddressInfo, connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  advertisedName,
  type BedrockOptions,
  bedrockFromEnv,
  geyserEnv,
  prepareGeyserDir,
  signalingDoor,
  untilItHolds,
} from './bedrock.ts'
import { nethernetIdentity } from './nethernet-identity.ts'

test('without a Floodgate key the edge takes Java players only', () => {
  expect(bedrockFromEnv({}, 25565)).toBeNull()
})

test('NetherNet players are sent to the edge by a name under the first play domain, unless told another', () => {
  const key = Buffer.alloc(16).toString('base64')
  expect(advertisedName('play.cubepals.com, play.example.test')).toBe('bedrock.play.cubepals.com')
  expect(advertisedName(undefined)).toBeNull()
  expect(advertisedName('')).toBeNull()
  expect(bedrockFromEnv({ FLOODGATE_KEY: key, BEDROCK_ADVERTISE: 'edge.example.test' }, 25565)).toMatchObject(
    {
      advertise: 'edge.example.test',
      webrtcPort: 19133,
      signalingPort: 19134,
    },
  )
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

test('its folder gets what was fetched at build, the key and identity for this user alone, and its config', () => {
  const root = mkdtempSync(join(tmpdir(), 'geyser-'))
  const warm = join(root, 'warm')
  mkdirSync(join(warm, 'cache'), { recursive: true })
  writeFileSync(join(warm, 'cache', 'client_jar.hash'), 'abc')
  const dir = join(root, 'run')
  const options = {
    ...(bedrockFromEnv({ FLOODGATE_KEY: KEY, GEYSER_DIR: dir, GEYSER_WARM: warm }, 25570) as BedrockOptions),
  }
  const place = { address: '172.19.0.2', publicAddress: '198.51.100.7' }
  prepareGeyserDir(options, place)
  expect(readFileSync(join(dir, 'cache', 'client_jar.hash'), 'utf8')).toBe('abc')
  expect(Buffer.from(readFileSync(join(dir, 'key.pem'))).toString('base64')).toBe(KEY)
  expect(statSync(join(dir, 'key.pem')).mode & 0o777).toBe(0o600)
  const identity = join(dir, 'nethernet', 'identity.pem')
  expect(readFileSync(identity, 'utf8')).toBe(nethernetIdentity(Buffer.from(KEY, 'base64')))
  expect(statSync(identity).mode & 0o777).toBe(0o600)
  const config = readFileSync(join(dir, 'config.yml'), 'utf8')
  expect(config).toContain('port: 25570')
  expect(config).toContain('  address: 172.19.0.2')
  expect(config).toContain('    - "198.51.100.7:19133"')
  expect(() => prepareGeyserDir({ ...options, key: 'AAAA' }, place)).toThrow('16 bytes')
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

test('the signaling door passes what Fly’s proxy sends to Geyser as it came, and Geyser’s answer back', async () => {
  const seen: string[] = []
  const geyser = createServer((socket) =>
    socket.on('data', (chunk) => {
      seen.push(chunk.toString())
      socket.end('HTTP/1.1 204 No Content\r\n\r\n')
    }),
  )
  await new Promise<void>((done) => geyser.listen(0, '127.0.0.1', done))
  const door = signalingDoor(0, `127.0.0.1:${(geyser.address() as AddressInfo).port}`)
  await once(door, 'listening')
  const request =
    'GET / HTTP/1.1\r\nHost: maple-hollow.play.example.test:19132\r\nX-Forwarded-For: 198.51.100.7\r\n\r\n'
  const client = connect((door.address() as AddressInfo).port, '127.0.0.1')
  client.write(request)
  const [answer] = (await once(client, 'data')) as [Buffer]
  expect(answer.toString()).toStartWith('HTTP/1.1 204')
  expect(seen.join('')).toBe(request)
  client.destroy()
  door.close()
  geyser.close()
})

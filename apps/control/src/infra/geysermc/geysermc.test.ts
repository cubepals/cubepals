// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GeyserMC's two services as Blockly reads them. The shapes are the ones the services answered on
 * 2026-10-22: a project lists its versions, a build lists its jars with their SHA-256, and the Xbox
 * lookup answers a 400 with a message for a gamertag it has not seen.
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { GeyserMcService } from './geysermc.ts'

const JAR = Buffer.from('a plugin jar')
const SHA256 = createHash('sha256').update(JAR).digest('hex')

const answering = (routes: Record<string, () => Response>) =>
  (async (input: string | URL | Request) => {
    const url = String(input)
    const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))
    return route === undefined ? new Response('', { status: 404 }) : route[1]()
  }) as typeof globalThis.fetch

const FLOODGATE = {
  '/projects/floodgate': () => Response.json({ versions: ['2.2.4', '2.2.5'] }),
  '/versions/2.2.5/builds/latest': () =>
    Response.json({ build: 141, downloads: { spigot: { name: 'floodgate-spigot.jar', sha256: SHA256 } } }),
  '/builds/141/downloads/spigot': () => new Response(JAR),
}

describe('Floodgate’s build', () => {
  test('is the newest version’s newest build, with the hashes of the bytes that arrived', async () => {
    const jar = await new GeyserMcService({ fetch: answering(FLOODGATE) }).latestFloodgate()
    expect(jar).toEqual({
      version: '2.2.5',
      build: 141,
      fileName: 'floodgate-spigot.jar',
      url: 'https://download.geysermc.org/v2/projects/floodgate/versions/2.2.5/builds/141/downloads/spigot',
      sha512: createHash('sha512').update(JAR).digest('hex'),
      sizeBytes: JAR.length,
    })
  })

  test('is refused when the bytes are not the ones GeyserMC lists', async () => {
    const other = { ...FLOODGATE, '/builds/141/downloads/spigot': () => new Response('another jar') }
    await expect(new GeyserMcService({ fetch: answering(other) }).latestFloodgate()).rejects.toThrow(
      'does not match',
    )
  })
})

describe('a gamertag’s Xbox user id', () => {
  test('is the digits GeyserMC answers, and a gamertag it has not seen is none', async () => {
    const service = new GeyserMcService({
      fetch: answering({
        '/xuid/Pixel': () => Response.json({ xuid: 2535400000000000 }),
        '/xuid/Nobody': () =>
          Response.json({ message: 'Unable to find user in our cache.' }, { status: 400 }),
      }),
    })
    expect(await service.xuidOf('Pixel')).toBe('2535400000000000')
    expect(await service.xuidOf('Nobody')).toBeNull()
  })

  test('is a failure, not an absence, when GeyserMC is down', async () => {
    const service = new GeyserMcService({
      fetch: answering({ '/xuid/Pixel': () => new Response('', { status: 503 }) }),
    })
    await expect(service.xuidOf('Pixel')).rejects.toThrow('503')
  })
})

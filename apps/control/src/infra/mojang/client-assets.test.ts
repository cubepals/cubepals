/**
 * The client jar as Mojang's endpoints serve it, played by a tiny jar made here with made-up
 * textures: CI never downloads Mojang's. What is checked is what keeps Blockly honest about the
 * art: the jar must be the one the manifest describes, only item art is kept, and it is fetched
 * once per release, then read from disk.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { ClientJarRejected } from '../../app/ports/minecraft.ts'
import { MojangClientAssets } from './client-assets.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const JAR = zipSync({
  'assets/minecraft/textures/item/made_up_sword.png': PNG,
  'assets/minecraft/textures/block/made_up_stone.png': PNG,
  'assets/minecraft/models/item/made_up_sword.json': strToU8('{"parent":"item/handheld"}'),
  'assets/minecraft/items/made_up_sword.json': strToU8('{"model":{"type":"minecraft:model"}}'),
  'assets/minecraft/sounds/ambient.ogg': new Uint8Array(64),
  'net/minecraft/client/Main.class': new Uint8Array(64),
})
const sha1 = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex')

/** Mojang's three endpoints, counting what is asked of them; `served` is the jar they hand out. */
function mojang(served: Uint8Array, listed = sha1(JAR)) {
  const asked: string[] = []
  const answer = (async (input: string | URL | Request) => {
    const url = String(input)
    asked.push(url)
    if (url === 'https://manifest.test/v2.json')
      return Response.json({ versions: [{ id: '26.3', url: 'https://meta.test/26.3.json' }] })
    if (url === 'https://meta.test/26.3.json')
      return Response.json({
        downloads: { client: { url: 'https://data.test/client.jar', sha1: listed, size: JAR.length } },
      })
    if (url === 'https://data.test/client.jar') return new Response(served)
    return new Response(null, { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch: answer, asked }
}

const roots: string[] = []
const root = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blockly-client-assets-'))
  roots.push(dir)
  return dir
}
afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true })
})

describe('a release’s item art, from its client jar', () => {
  test('kept: the item art and nothing else, read by its path under assets/minecraft/', async () => {
    const { fetch } = mojang(JAR)
    const files = await new MojangClientAssets({
      root: await root(),
      fetch,
      manifest: 'https://manifest.test/v2.json',
    }).open('26.3')
    expect(files.read('textures/item/made_up_sword.png')).toEqual(PNG)
    expect(files.read('items/made_up_sword.json')).not.toBeNull()
    expect(files.read('sounds/ambient.ogg')).toBeNull()
    expect(files.read('textures/item/missing.png')).toBeNull()
  })

  test('a jar that isn’t the one the manifest describes is refused, and nothing of it is kept', async () => {
    const tampered = new Uint8Array(JAR)
    tampered[40] = (tampered[40] ?? 0) ^ 0xff
    const dir = await root()
    const { fetch } = mojang(tampered)
    const assets = new MojangClientAssets({ root: dir, fetch, manifest: 'https://manifest.test/v2.json' })
    await expect(assets.open('26.3')).rejects.toBeInstanceOf(ClientJarRejected)
    expect(await readdir(dir)).toEqual([])
  })

  test('fetched once: asked again it is in memory, and after a restart on disk', async () => {
    const dir = await root()
    const first = mojang(JAR)
    const assets = new MojangClientAssets({
      root: dir,
      fetch: first.fetch,
      manifest: 'https://manifest.test/v2.json',
    })
    await Promise.all([assets.open('26.3'), assets.open('26.3')])
    await assets.open('26.3')
    expect(first.asked).toEqual([
      'https://manifest.test/v2.json',
      'https://meta.test/26.3.json',
      'https://data.test/client.jar',
    ])
    const restarted = mojang(JAR)
    const again = new MojangClientAssets({
      root: dir,
      fetch: restarted.fetch,
      manifest: 'https://manifest.test/v2.json',
    })
    expect((await again.open('26.3')).read('textures/block/made_up_stone.png')).toEqual(PNG)
    expect(restarted.asked).toEqual([])
  })

  test('only a release’s name reaches a path', async () => {
    const { fetch, asked } = mojang(JAR)
    const assets = new MojangClientAssets({
      root: await root(),
      fetch,
      manifest: 'https://manifest.test/v2.json',
    })
    await expect(assets.open('../../etc')).rejects.toThrow('Not a release')
    await expect(assets.open('1.99')).rejects.toThrow('Mojang lists no release 1.99')
    expect(asked).toEqual(['https://manifest.test/v2.json'])
  })
})

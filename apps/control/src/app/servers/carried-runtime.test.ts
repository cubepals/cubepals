// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a revision places on the volume itself, run the way a server starts: the files Cubepals
 * carries, replaced at every start, and a plugin whose jar goes in a folder of its own, fetched and
 * checked by its hash. The step runs here in a real shell against a folder standing in for the
 * volume, with a local server standing in for the artifact links.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { RUNNING_LEVEL } from '../../domain/revision/carried.ts'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { placeablePath } from '../../minecraft/carried.ts'
import { installCheck } from '../../minecraft/install-check.ts'
import { toRuntimeSpec } from '../../minecraft/runtime-spec.ts'

const BENTOBOX = Buffer.from('bentobox jar')
const AONEBLOCK = Buffer.from('aoneblock jar')
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('hex')

const plugin = (name: string, bytes: Buffer, dir?: string): PinnedMod => ({
  source: { catalog: 'modrinth', projectId: name.toLowerCase(), versionId: `${name}-1` },
  name,
  versionLabel: '1.0',
  artifact: {
    ref: { kind: 'remote', url: `https://cdn.example.test/${name}.jar` },
    sha512: sha512(bytes),
    sizeBytes: bytes.length,
    fileName: `${name}.jar`,
  },
  environment: 'server',
  loaders: ['paper'],
  gameVersions: ['26.1.2'],
  origin: 'user',
  requiredBy: [],
  ...(dir === undefined ? {} : { dir }),
})

const LIFESTEAL = 'startHearts: 7\nmaxHearts: 12\n'

/** A template-shaped revision: Paper, one plugin in its folder, a game mode in BentoBox's, and settings. */
const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '26.1.2',
  loader: 'paper',
  loaderVersion: '40',
  settings: defaultSettings({ name: 'Island', gameMode: 'survival', maxPlayers: 10 }),
  mods: [
    plugin('BentoBox', BENTOBOX),
    plugin('AOneBlock', AONEBLOCK, 'plugins/BentoBox/addons'),
    plugin('LifeStealZ', Buffer.from('lifestealz jar')),
  ],
  modpack: null,
  files: [{ path: 'plugins/LifeStealZ/config.yml', content: LIFESTEAL }],
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
}

let served = 0
let links: Bun.Server<undefined>
const linkOf = (artifact: { fileName: string }) => `http://127.0.0.1:${links.port}/${artifact.fileName}`

const input = {
  serverId: 's-1',
  world: {
    id: 'w',
    serverId: 's-1',
    levelName: 'world',
    name: 'World',
    seed: null,
    levelType: 'minecraft:normal',
    hardcore: false,
    generatedOnVersion: '26.1.2',
  },
  memoryTier: '4g' as const,
  rconPassword: 'secret',
  artifactUrl: linkOf,
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
}

beforeAll(() => {
  links = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      served += 1
      const name = new URL(request.url).pathname.slice(1)
      if (name === 'AOneBlock.jar') return new Response(AONEBLOCK)
      if (name === 'BentoBox.jar') return new Response(BENTOBOX)
      return new Response('not here', { status: 404 })
    },
  })
})
afterAll(() => links.stop(true))

/**
 * Starts a server of this revision on `data`, running `levelName`, as far as the image's own start,
 * which it skips. Not `spawnSync`: the links are served from this same thread.
 */
async function start(data: string, of: ServerRevision, levelName = input.world.levelName): Promise<number> {
  const spec = toRuntimeSpec({ ...input, world: { ...input.world, levelName }, revision: of })
  const step = (spec.entrypoint?.[2] ?? '')
    .replaceAll('/data', data)
    .replace('exec /image/scripts/start "$@"', 'true')
  const env = Object.fromEntries(Object.entries(spec.env).filter(([name]) => name.startsWith('BLOCKLY_')))
  return Bun.spawn(['/bin/sh', '-c', step], {
    env: { ...env, VERSION: '26.1.2', PAPER_BUILD: '40' },
    stderr: 'ignore',
  }).exited
}

describe('what a revision places itself', () => {
  test('the image installs the plugins folder; a game mode in a folder of its own and the files are Blockly’s', () => {
    const spec = toRuntimeSpec({ ...input, revision })
    expect(spec.env.PLUGINS?.split(',')).toEqual([
      linkOf({ fileName: 'BentoBox.jar' }),
      linkOf({ fileName: 'LifeStealZ.jar' }),
    ])
    expect(spec.env.BLOCKLY_JARS).toBe(
      `plugins/BentoBox/addons/${sha512(AONEBLOCK).slice(0, 12)}-AOneBlock.jar ${sha512(AONEBLOCK)} ${linkOf({ fileName: 'AOneBlock.jar' })}`,
    )
    expect(spec.env.BLOCKLY_FILES).toBe(
      `plugins/LifeStealZ/config.yml ${Buffer.from(LIFESTEAL).toString('base64')}`,
    )
    // After Paper's own step, before the image's start.
    expect(spec.entrypoint?.[2]).toContain('BLOCKLY_FILES')
    expect(spec.entrypoint?.[2]).toEndWith('exec /image/scripts/start "$@"')
  })

  test('a server that places nothing starts as it did before', () => {
    const plain = { ...revision, mods: [plugin('BentoBox', BENTOBOX)], files: [] }
    const spec = toRuntimeSpec({ ...input, revision: plain })
    expect(spec.entrypoint?.[2]).not.toContain('BLOCKLY_FILES')
    expect(spec.env.BLOCKLY_FILES).toBeUndefined()
    expect(spec.env.BLOCKLY_JARS).toBeUndefined()
  })

  test('only plain relative paths, and none Blockly keeps itself', () => {
    expect(placeablePath('plugins/LifeStealZ/config.yml')).toBe(true)
    expect(placeablePath('plugins/BentoBox/addons/abc-AOneBlock-1.0+26.1.jar')).toBe(true)
    expect(placeablePath('bukkit.yml')).toBe(true)
    for (const path of [
      '',
      '/data/x',
      '../x',
      'plugins/../x',
      'a//b',
      'a b',
      'a"b',
      'server.properties',
      'ops.json',
      '.blockly-files',
    ])
      expect(placeablePath(path)).toBe(false)
  })

  test('a path Cubepals may not write is a mistake, never skipped', () => {
    for (const path of [
      '../escape.yml',
      '/etc/passwd',
      'server.properties',
      'plugins/a b/config.yml',
      '.blockly-pack',
    ])
      expect(() =>
        toRuntimeSpec({ ...input, revision: { ...revision, files: [{ path, content: 'x' }] } }),
      ).toThrow('Cubepals can')
  })

  test('files go in before the first start, replace what is there at every start, and go when dropped', async () => {
    const data = mkdtempSync(join(tmpdir(), 'carried-'))
    const config = `${data}/plugins/LifeStealZ/config.yml`
    const addon = `${data}/plugins/BentoBox/addons/${sha512(AONEBLOCK).slice(0, 12)}-AOneBlock.jar`
    served = 0
    expect(await start(data, revision)).toBe(0)
    expect(readFileSync(config, 'utf8')).toBe(LIFESTEAL)
    expect(readFileSync(addon)).toEqual(AONEBLOCK)
    expect(served).toBe(1)

    // The plugin writes beside it, and something rewrites the file: the next start puts it back.
    writeFileSync(`${data}/plugins/LifeStealZ/storage.yml`, 'the plugin’s own')
    writeFileSync(config, 'startHearts: 20\n')
    expect(await start(data, revision)).toBe(0)
    expect(readFileSync(config, 'utf8')).toBe(LIFESTEAL)
    // A jar already holding its bytes isn't fetched again.
    expect(served).toBe(1)

    // A later revision with another value: the server reads that one.
    const later = {
      ...revision,
      files: [{ path: 'plugins/LifeStealZ/config.yml', content: 'maxHearts: 30\n' }],
    }
    expect(await start(data, later)).toBe(0)
    expect(readFileSync(config, 'utf8')).toBe('maxHearts: 30\n')

    // Dropped: the file and the jar Cubepals placed go, and what the plugin wrote stays.
    const plain = {
      ...revision,
      mods: [plugin('BentoBox', BENTOBOX), plugin('Extra', Buffer.from('x'), 'plugins/Extra')],
      files: [],
    }
    rmSync(`${data}/plugins/Extra`, { recursive: true, force: true })
    mkdirSync(`${data}/plugins/Extra`, { recursive: true })
    writeFileSync(`${data}/plugins/Extra/${sha512(Buffer.from('x')).slice(0, 12)}-Extra.jar`, 'x')
    expect(await start(data, plain)).toBe(0)
    expect(existsSync(config)).toBe(false)
    expect(existsSync(addon)).toBe(false)
    expect(readFileSync(`${data}/plugins/LifeStealZ/storage.yml`, 'utf8')).toBe('the plugin’s own')
    rmSync(data, { recursive: true })
  })

  test('a jar that arrives with other bytes stops the start, and nothing half-fetched stays', async () => {
    const data = mkdtempSync(join(tmpdir(), 'carried-'))
    const wrong = {
      ...revision,
      mods: [
        {
          ...plugin('AOneBlock', AONEBLOCK, 'plugins/BentoBox/addons'),
          artifact: { ...plugin('AOneBlock', AONEBLOCK).artifact, sha512: sha512(BENTOBOX) },
        },
      ],
    }
    expect(await start(data, wrong)).not.toBe(0)
    expect(Bun.spawnSync(['find', data, '-name', '*.jar*']).stdout.toString()).toBe('')
    rmSync(data, { recursive: true })
  })

  test('the check after a start hashes a placed jar where it was placed', () => {
    const check = installCheck(revision)
    if (check === null) throw new Error('expected a check')
    const placed = `plugins/BentoBox/addons/${sha512(AONEBLOCK).slice(0, 12)}-AOneBlock.jar`
    expect(check.expected.map((jar) => jar.name)).toContain(placed)
    expect(check.command.join(' ')).toContain('cd /data && for f in plugins/BentoBox/addons/*.jar')
  })
})

describe('the world a carried file names', () => {
  test('a file naming the running world names the one the server starts on, before and after a switch', async () => {
    const data = mkdtempSync(join(tmpdir(), 'carried-'))
    const arena = `${data}/plugins/Arena/config.yml`
    const naming = {
      ...revision,
      files: [{ path: 'plugins/Arena/config.yml', content: `Spawn: { World: ${RUNNING_LEVEL}, Y: -60 }\n` }],
    }
    expect(await start(data, naming)).toBe(0)
    expect(readFileSync(arena, 'utf8')).toBe('Spawn: { World: world, Y: -60 }\n')
    expect(await start(data, naming, 'world-2')).toBe(0)
    expect(readFileSync(arena, 'utf8')).toBe('Spawn: { World: world-2, Y: -60 }\n')
    // Switching back puts the first world's name back.
    expect(await start(data, naming)).toBe(0)
    expect(readFileSync(arena, 'utf8')).toBe('Spawn: { World: world, Y: -60 }\n')
    rmSync(data, { recursive: true })
  })
})

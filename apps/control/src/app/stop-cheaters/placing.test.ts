// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stop cheaters' punishments file and Grim's jar as a start places them, run the way a server
 * starts: the step in a real shell against a folder standing in for the volume, with a local server
 * standing in for the artifact links. None, Cubepals', Grim's own actions only, and the owner's own;
 * what is kept aside and put back; and the jar, placed and taken away.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { toRuntimeSpec } from '../../minecraft/runtime-spec.ts'
import { DEFAULT_PUNISHMENTS, PUNISHMENTS_FILE, stopCheatersEnv } from '../../minecraft/stop-cheaters.ts'

const JAR = Buffer.from('grim jar')
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('hex')

const grim: PinnedMod = {
  source: { catalog: 'modrinth', projectId: 'LJNGWSvH', versionId: 'grim-1' },
  name: 'Grim Anticheat',
  versionLabel: '2.3',
  artifact: {
    ref: { kind: 'remote', url: 'https://cdn.example.test/grim.jar' },
    sha512: sha512(JAR),
    sizeBytes: JAR.length,
    fileName: 'grim.jar',
  },
  environment: 'server',
  loaders: ['paper'],
  gameVersions: ['1.21.11'],
  origin: 'user',
  requiredBy: [],
  dir: 'plugins',
}

const revision: ServerRevision = {
  id: 'r',
  serverId: 's-1',
  number: 1,
  gameVersion: '1.21.11',
  loader: 'paper',
  loaderVersion: '40',
  settings: defaultSettings({ name: 'Pit', gameMode: 'survival', maxPlayers: 10 }),
  mods: [],
  modpack: null,
  files: [],
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
}

let links: Bun.Server<undefined>
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
    generatedOnVersion: '1.21.11',
  },
  memoryTier: '4g' as const,
  rconPassword: 'secret',
  artifactUrl: (artifact: { fileName: string }) => `http://127.0.0.1:${links.port}/${artifact.fileName}`,
  limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
  iconUrl: null,
}

beforeAll(() => {
  links = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(JAR) })
})
afterAll(() => links.stop(true))

const OURS =
  'Punishments:\n  Simulation:\n    commands:\n      - "100:40 cubepals-remove %player% movement"\n'

/** Starts a server on `data` as far as the image's own start: on with `punishments`, or off with null. */
async function start(data: string, punishments: string | null, takeOver = false): Promise<number> {
  const spec = toRuntimeSpec({ ...input, revision, compat: punishments === null ? [] : [grim] })
  // As `servers/specs.ts` adds them.
  Object.assign(spec.env, stopCheatersEnv(punishments === null ? null : { punishments, takeOver }))
  const step = (spec.entrypoint?.[2] ?? '')
    .replaceAll('/data', data)
    .replace('exec /image/scripts/start "$@"', 'true')
  const env = Object.fromEntries(Object.entries(spec.env).filter(([name]) => name.startsWith('BLOCKLY_')))
  return Bun.spawn(['/bin/sh', '-c', step], {
    env: { ...env, VERSION: '1.21.11', PAPER_BUILD: '40' },
    stderr: 'ignore',
  }).exited
}

const volume = () => {
  const data = mkdtempSync(join(tmpdir(), 'stop-cheaters-'))
  mkdirSync(join(data, 'plugins/GrimAC'), { recursive: true })
  return data
}
const read = (data: string, path: string) =>
  existsSync(join(data, path)) ? readFileSync(join(data, path), 'utf8') : null
const KEPT = `${PUNISHMENTS_FILE}.before-cubepals`
const mark = (data: string) => read(data, '.blockly-stop-cheaters')?.trim() ?? null
/** The files kept aside by their time, where one was kept already. */
const timestamped = (data: string) =>
  readdirSync(join(data, 'plugins/GrimAC')).filter((name) => /\.before-cubepals\.\d+$/.test(name))
const grimJars = (data: string) => readdirSync(join(data, 'plugins')).filter((name) => name.endsWith('.jar'))

describe('Stop cheaters at a start', () => {
  test('with no file, Cubepals’ goes in, marked as its own, with Grim’s jar', async () => {
    const data = volume()
    expect(await start(data, OURS)).toBe(0)
    expect(read(data, PUNISHMENTS_FILE)).toStartWith('# Written by Cubepals')
    expect(read(data, PUNISHMENTS_FILE)).toContain('cubepals-remove %player% movement')
    expect(read(data, KEPT)).toBeNull()
    expect(mark(data)).toBe('ours')
    expect(grimJars(data)).toEqual([`cubepals-${sha512(JAR).slice(0, 12)}-grim.jar`])
  })

  test('a file Cubepals wrote is replaced, with no copy kept', async () => {
    const data = volume()
    await start(data, DEFAULT_PUNISHMENTS)
    await start(data, OURS)
    expect(read(data, PUNISHMENTS_FILE)).toContain('cubepals-remove')
    expect(read(data, KEPT)).toBeNull()
  })

  test('a file of Grim’s own actions only is kept aside, replaced, and back when it goes off', async () => {
    const data = volume()
    const builtIn =
      'Punishments:\n  Reach:\n    commands:\n      - "5:5 [alert]"\n      - \'5:5 [webhook]\'\n'
    writeFileSync(join(data, PUNISHMENTS_FILE), builtIn)
    await start(data, OURS)
    expect(read(data, KEPT)).toBe(builtIn)
    expect(read(data, PUNISHMENTS_FILE)).toContain('cubepals-remove')
    expect(mark(data)).toBe('ours')
    // Off: Cubepals' file goes, the kept one comes back, and so does Grim's jar.
    expect(await start(data, null)).toBe(0)
    expect(read(data, PUNISHMENTS_FILE)).toBe(builtIn)
    expect(read(data, KEPT)).toBeNull()
    expect(mark(data)).toBeNull()
    expect(grimJars(data)).toEqual([])
  })

  test('a file kept aside before is never written over, and the newer one is kept by its time', async () => {
    const data = volume()
    const newer = 'Punishments:\n  Reach:\n    commands:\n      - "5:5 [log]"\n'
    writeFileSync(join(data, KEPT), 'the first one\n')
    writeFileSync(join(data, PUNISHMENTS_FILE), newer)
    await start(data, OURS)
    expect(read(data, KEPT)).toBe('the first one\n')
    expect(read(data, PUNISHMENTS_FILE)).toContain('cubepals-remove')
    expect(timestamped(data).map((name) => read(data, `plugins/GrimAC/${name}`))).toEqual([newer])
  })

  test('taking over with a file kept already loses neither the kept one nor the owner’s new one', async () => {
    const data = volume()
    const theirs = 'Punishments:\n  Reach:\n    commands:\n      - "5:5 kick %player% reach"\n'
    writeFileSync(join(data, KEPT), 'kept earlier\n')
    writeFileSync(join(data, PUNISHMENTS_FILE), theirs)
    await start(data, OURS)
    expect(mark(data)).toBe('own')
    await start(data, OURS, true)
    expect(mark(data)).toBe('ours')
    expect(read(data, KEPT)).toBe('kept earlier\n')
    const [stamped = ''] = timestamped(data)
    expect(stamped).toMatch(/^punishments\.yml\.before-cubepals\.\d+$/)
    expect(read(data, `plugins/GrimAC/${stamped}`)).toBe(theirs)
  })

  test('the owner’s own is left, marked own; “Use Cubepals’ settings” moves it aside', async () => {
    const data = volume()
    const theirs = 'Punishments:\n  Reach:\n    commands:\n      - "5:5 kick %player% reach"\n'
    writeFileSync(join(data, PUNISHMENTS_FILE), theirs)
    await start(data, OURS)
    expect(read(data, PUNISHMENTS_FILE)).toBe(theirs)
    expect(read(data, KEPT)).toBeNull()
    expect(mark(data)).toBe('own')
    // Off, theirs stays where it is.
    await start(data, null)
    expect(read(data, PUNISHMENTS_FILE)).toBe(theirs)
    // On again and taken over: theirs is kept, Cubepals' is in place, and off puts theirs back.
    await start(data, OURS, true)
    expect(read(data, KEPT)).toBe(theirs)
    expect(mark(data)).toBe('ours')
    await start(data, null)
    expect(read(data, PUNISHMENTS_FILE)).toBe(theirs)
  })

  test('a file with no command lines it can read is the owner’s, and stays', async () => {
    const data = volume()
    for (const theirs of [
      'Punishments:\n  Reach:\n    checks: [Reach]\n    commands: ["5:5 kick %player% reach"]\n',
      'Punishments: {}\n',
    ]) {
      writeFileSync(join(data, PUNISHMENTS_FILE), theirs)
      await start(data, OURS)
      expect(read(data, PUNISHMENTS_FILE)).toBe(theirs)
      expect(read(data, KEPT)).toBeNull()
      expect(mark(data)).toBe('own')
    }
  })

  test('off on a server that never ran it changes nothing', async () => {
    const data = volume()
    writeFileSync(join(data, PUNISHMENTS_FILE), 'x: 1\n')
    expect(await start(data, null)).toBe(0)
    expect(read(data, PUNISHMENTS_FILE)).toBe('x: 1\n')
  })
})

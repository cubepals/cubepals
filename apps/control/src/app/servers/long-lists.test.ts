// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server with a few hundred mods starts: no variable it is given comes near Linux's 131,072
 * bytes for one (`MAX_ARG_STRLEN`). A list of mods or plugins too long for one goes compressed, and
 * the start hands it to the image as a file; a start that would still pass the limit is refused in
 * a sentence before a machine fails on it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { defaultSettings, type ServerRevision } from '../../domain/revision/revision.ts'
import { JAR_LISTS } from '../../minecraft/jars.ts'
import { toRuntimeSpec } from '../../minecraft/runtime-spec.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { ArtifactLinks } from '../artifacts/links.ts'
import { ownersWords, PermanentFailure } from '../errors.ts'
import { singleKey } from '../secrets.ts'
import { listLines, tooLongForAStart, VARIABLE_BYTES_LIMIT, withCompressedFiles } from './carried-files.ts'

/** Linux's limit on one argument or variable, `MAX_ARG_STRLEN` (32 pages of 4 KiB). */
const LINUX_MAX_ARG_STRLEN = 131_072

const SERVER = '0b9f3c1e-6a4d-4f7e-9a51-2d7c8e5f1a90'

const mod = (i: number): PinnedMod => ({
  source: { catalog: 'modrinth', projectId: `p${i}`, versionId: `v${i}` },
  name: `Mod ${i}`,
  versionLabel: '1.0',
  artifact: {
    ref: { kind: 'remote', url: `https://cdn.modrinth.com/data/p${i}/m.jar` },
    sha512: createHash('sha512').update(String(i)).digest('hex'),
    sizeBytes: 1000,
    fileName: `some-fabric-mod-${i}-0.6.13+mc1.21.11.jar`,
  },
  environment: 'server',
  loaders: ['fabric'],
  gameVersions: ['1.21.11'],
  origin: 'user',
  requiredBy: [],
})

const revisionWith = (count: number): ServerRevision => ({
  id: 'r',
  serverId: SERVER,
  number: 1,
  gameVersion: '1.21.11',
  loader: 'fabric',
  loaderVersion: '0.17.2',
  settings: defaultSettings({ name: 'Modded', gameMode: 'survival', maxPlayers: 10 }),
  mods: Array.from({ length: count }, (_, i) => mod(i)),
  modpack: null,
  files: [],
  acknowledgedRevoked: [],
  reason: 'created',
  basedOnRevisionId: null,
  createdBy: 'u',
})

const links = new ArtifactLinks('https://control.example.test', singleKey('k'.repeat(32)))

/** The spec as it is built, before a start compresses anything. */
const plainOf = (count: number) =>
  toRuntimeSpec({
    serverId: SERVER,
    revision: revisionWith(count),
    world: {
      id: 'w',
      serverId: SERVER,
      levelName: 'world',
      name: 'World',
      seed: null,
      levelType: 'minecraft:normal',
      hardcore: false,
      generatedOnVersion: '1.21.11',
    },
    memoryTier: '8g',
    rconPassword: 'secret',
    artifactUrl: links.forServer(SERVER),
    limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 20 },
    iconUrl: null,
    brandPack: null,
  })

/** The spec as a start is given it. */
const specOf = (count: number) => withCompressedFiles(plainOf(count))

let root = ''
afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
  root = ''
})

/**
 * Runs a start of `count` mods on `data` as far as the image's own start, and returns what the image
 * would be given: its `MODS` and, where there is one, the file its `MODS_FILE` names.
 */
async function start(data: string, count: number): Promise<{ mods: string; file: string | null }> {
  const spec = specOf(count)
  const listFile = join(root, 'list')
  const seen = join(root, 'seen')
  const script = (spec.entrypoint?.[2] ?? '')
    .replaceAll('/tmp/blockly-mods', listFile)
    .replace(/\/data(?![A-Za-z])/g, data)
    .replace('exec /image/scripts/start "$@"', `printf '%s\\n%s' "$MODS" "$MODS_FILE" > ${seen}`)
  const env = Object.fromEntries(
    Object.entries(spec.env).filter(([name]) => name.startsWith('BLOCKLY_') || name === 'MODS'),
  )
  const exited = await Bun.spawn(['/bin/sh', '-c', script], {
    env: { ...env, TYPE: 'FABRIC', LEVEL: 'world' },
    stderr: 'ignore',
  }).exited
  expect(exited).toBe(0)
  const [mods = '', file = ''] = readFileSync(seen, 'utf8').split('\n')
  return { mods, file: file === '' ? null : readFileSync(file, 'utf8').trim() }
}

describe('a server with many mods', () => {
  test('a Fabric server with 450 mods starts with every variable under the limit', () => {
    const plain = plainOf(450).env.MODS ?? ''
    // As one plain list, these mods pass Linux's limit before 450 of them.
    let first = 1
    while (Buffer.byteLength(`MODS=${plainOf(first).env.MODS ?? ''}`) <= LINUX_MAX_ARG_STRLEN) first++
    expect(first).toBeLessThan(450)
    expect(Buffer.byteLength(`MODS=${plain}`)).toBeGreaterThan(LINUX_MAX_ARG_STRLEN)
    const spec = specOf(450)
    for (const [name, value] of [
      ...Object.entries(spec.env),
      ...(spec.entrypoint ?? []).map((part, i) => [`entrypoint ${i}`, part]),
    ])
      expect(`${name}: ${Buffer.byteLength(`${name}=${value}`)} bytes`).toBe(
        `${name}: ${Math.min(Buffer.byteLength(`${name}=${value}`), VARIABLE_BYTES_LIMIT)} bytes`,
      )
    // Every link is there, in its order.
    expect(spec.env.MODS).toBeUndefined()
    expect(listLines(spec.env, JAR_LISTS.MODS).split('\n')).toEqual(plain.split(','))
    expect(tooLongForAStart(spec)).toBeNull()
  })

  test('a server with a few mods is given its list as before', () => {
    expect(specOf(3).env.MODS).toBe(plainOf(3).env.MODS)
    expect(specOf(3).env.BLOCKLY_MODS_GZ).toBeUndefined()
  })

  test('the start hands a long list to the image as a file, and keeps doing so on that volume', async () => {
    root = mkdtempSync(join(tmpdir(), 'long-lists-'))
    const data = join(root, 'data')
    Bun.spawnSync(['mkdir', data])
    // A volume that never had a long list starts as it always did.
    expect(await start(data, 2)).toEqual({ mods: plainOf(2).env.MODS ?? '', file: null })
    // A long one goes as a file, and the image's own variable is left empty.
    expect(await start(data, 450)).toEqual({
      mods: '',
      file: (plainOf(450).env.MODS ?? '').replaceAll(',', '\n'),
    })
    // Back to a few, it stays a file, so the image cleans up after the jars it installed from one.
    expect(await start(data, 2)).toEqual({
      mods: '',
      file: (plainOf(2).env.MODS ?? '').replaceAll(',', '\n'),
    })
    expect(existsSync(join(data, '.blockly-mods-file'))).toBe(true)
  })

  test('a start past what Linux takes is refused in a sentence', () => {
    expect(tooLongForAStart(specOf(2000))).toBe(
      'This server has too many mods, plugins and files to start. Removing some lets it start.',
    )
  })
})

describe.skipIf(!hasDatabase)('a start past what Linux takes, as its owner meets it', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(() => h.close())

  test('is refused in the sentence, once, rather than retried as an error on Cubepals’ side', async () => {
    const owner = await h.user('Steve', 'plus')
    const server = await h.create(owner)
    // Thousands of datapacks on its revision: more than one start can carry, even compressed.
    const datapacks = Array.from({ length: 2000 }, (_, i) => ({ ...mod(i), loaders: ['datapack'] }))
    await h.db
      .update(schema.serverRevisions)
      .set({ mods: datapacks })
      .where(eq(schema.serverRevisions.id, server.desiredRevisionId))
    const refused = await h.app.specs
      .desired(h.db, await h.server(server.id))
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(PermanentFailure)
    expect(ownersWords(refused)).toBe(
      'This server has too many mods, plugins and files to start. Removing some lets it start.',
    )
  })
})

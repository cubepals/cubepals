// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which of an uploaded pack's jars its servers run (docs/modpack-system.md § Sides): one the
 * catalog records as only for players' games is left to them, unless another mod of the pack
 * requires it, whether the pack lists it or carries it. Every jar here is built in the test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import type { PackImportView } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { ModEnvironment } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { classFile, fabricJar, unzipBytes, utf8, zipBytes } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'
import { loadPackContents } from './persistence.ts'

let h: Harness
const store = new MemoryStore()
const cdn = new Cdn()

beforeAll(async () => {
  if (!hasDatabase) return
  await store.start()
  await cdn.start()
  h = await startHarness({ capabilities: { archives: store, billing: null } })
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  store.close()
  cdn.close()
})

/** What a browser does: ask, put the bytes where it was told, say it is done; then wait for the read. */
const upload = async (owner: UserActor, bytes: Uint8Array, fileName: string): Promise<PackImportView> => {
  const start = await h.app.packs.beginUpload(owner, { fileName, sizeBytes: bytes.length })
  const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
  expect(put.status).toBe(200)
  const { importId } = await h.app.packs.finishUpload(owner, start.ticket)
  for (let tries = 0; tries < 120; tries++) {
    const view = await h.app.packs.view(owner, importId)
    if (view.status !== 'reading') return view
    await Bun.sleep(250)
  }
  throw new Error('The pack was still being read after 30 seconds')
}

/**
 * A Fabric mod for Minecraft 1.21.1, published on the catalog as running `environment`, and
 * requiring the projects `requires` names.
 */
const published = (name: string, environment: ModEnvironment, requires: readonly string[] = []) => {
  const id = `${name}${randomUUID().slice(0, 6)}`
  const bytes = zipBytes({
    ...unzipBytes(fabricJar(id, { depends: { minecraft: '1.21.1' } })),
    [`net/example/${id}/Mod.class`]: classFile({ name: `net/example/${id}/Mod` }),
  })
  const file = cdn.file(id, bytes)
  h.catalog.publish(
    {
      projectId: id,
      slug: id,
      name: id,
      summary: '',
      iconUrl: null,
      environments: [environment],
      downloads: 1,
    },
    [
      {
        versionId: `${id}-1`,
        projectId: id,
        versionLabel: '1',
        channel: 'release',
        state: 'listed',
        environment,
        loaders: ['fabric'],
        gameVersions: ['1.21.1'],
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file,
        dependencies: requires.map((projectId) => ({ projectId, versionId: null, kind: 'required' })),
      },
    ],
  )
  return { id, bytes, file }
}

/** The index entry of a Modrinth pack that lists `mod` at `path` by its catalog download. */
const listedAt = (path: string, mod: ReturnType<typeof published>) => ({
  path,
  hashes: { sha1: createHash('sha1').update(mod.bytes).digest('hex'), sha512: mod.file.sha512 },
  env: { client: 'required', server: 'required' },
  downloads: [mod.file.url],
  fileSize: mod.file.sizeBytes,
})

describe.skipIf(!hasDatabase)('the sides of an uploaded pack’s jars', () => {
  test('a companion for players’ games another mod requires is kept, listed or carried', async () => {
    const owner = await h.user('Ada', 'plus')
    const companion = published('companion', 'client_only_server_optional')
    const library = published('library', 'client_only_server_optional')
    const zoom = published('zoom', 'client_only_server_optional')
    const core = published('core', 'client_and_server', [companion.id, library.id])
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '1.0',
      name: 'Companions',
      files: [
        listedAt('mods/core.jar', core),
        listedAt('mods/companion.jar', companion),
        listedAt('mods/zoom.jar', zoom),
      ],
      dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
    }
    const view = await upload(
      owner,
      zipBytes({
        'modrinth.index.json': utf8(JSON.stringify(index)),
        'overrides/mods/library.jar': library.bytes,
      }),
      'Companions.mrpack',
    )
    if (view.status !== 'ready') throw new Error(`Refused: ${view.status === 'refused' ? view.message : ''}`)
    const [built] = await h.db
      .select({ sha512: schema.packImports.packSha512 })
      .from(schema.packImports)
      .where(eq(schema.packImports.id, view.importId))
    const contents = await loadPackContents(h.db, built?.sha512 ?? '')
    expect(contents?.jars.map((jar) => jar.path).sort()).toEqual([
      'mods/companion.jar',
      'mods/core.jar',
      'mods/library.jar',
    ])
    // One nothing requires is still left to players' games.
    expect(contents?.leftOut).toEqual([{ path: 'mods/zoom.jar', why: 'players', sha512: zoom.file.sha512 }])
  }, 60_000)
})

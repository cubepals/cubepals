// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Loader evidence refines real pinned pack contents, without promoting unrelated or unsafe jars. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { diagnose } from '../../minecraft/diagnosis.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { PackContents } from './contents.ts'
import { learnPack } from './startup-learning.ts'

describe.skipIf(!hasDatabase)('learning from actual loader evidence', () => {
  let h: Harness
  const cdn = new Cdn()
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('a client crash excludes its pinned jar once and preserves every other file', async () => {
    const { contents, pack } = await fixture(h, cdn, 'client')
    const found = diagnose([
      'java.awt.HeadlessException: ',
      'No X11 DISPLAY variable was set,',
      '\tat javax.swing.JFrame.<init>(Unknown Source) ~[?:?]',
      '\tat toni.fancymenu.MissingModsWindow.<init>(MissingModsWindow.java:55) ~[fancymenu.jar:?]',
    ])
    if (found === null) throw new Error('The captured loader crash was not diagnosed')
    expect(found.playersOnly).toEqual([{ name: 'fancymenu', id: null }])
    expect(await learnPack(contents, pack, found)).toBe(true)
    expect(await learnPack(contents, pack, found)).toBe(false)
    const saved = await contents.load(pack.artifact.sha512)
    expect(saved?.leftOut).toEqual([{ path: 'mods/fancymenu.jar', why: 'crashed' }])
    expect(saved?.jars.map((jar) => jar.path)).toEqual(['mods/fancymenu.jar'])
  })

  test('a missing server dependency is restored from the pinned remote index exactly once', async () => {
    const { contents, pack, dependency } = await fixture(h, cdn, 'missing')
    const found = diagnose([
      '[main/ERROR]: Crashed! The full crash report has been saved to ./crash-reports/crash.txt',
      'Cabricality requires version [2.5.3, ∞) of equator, which is missing!',
    ])
    if (found === null) throw new Error('The captured missing dependency was not diagnosed')
    expect(found.missing).toBe('equator')
    expect(await learnPack(contents, pack, found)).toBe(true)
    expect(await learnPack(contents, pack, found)).toBe(false)
    expect((await contents.load(pack.artifact.sha512))?.leftOut).toEqual([
      { path: 'mods/equator.jar', why: 'needed', sha512: dependency.sha512 },
    ])
  })

  test('an upload without a source URL and unrelated crashes cannot invent a server dependency', async () => {
    const { contents, pack } = await fixture(h, cdn, 'upload')
    const found = diagnose(['Cabricality requires version [2.5.3, ∞) of equator, which is missing!'])
    if (found === null) throw new Error('Missing dependency was not diagnosed')
    const uploaded: PinnedModpack = {
      ...pack,
      artifact: { ...pack.artifact, ref: { kind: 'stored', key: 'pack.mrpack' } },
    }
    expect(await learnPack(contents, uploaded, found)).toBe(false)
    const memory = diagnose(['java.lang.OutOfMemoryError: Java heap space'])
    if (memory === null) throw new Error('Memory failure was not diagnosed')
    expect(await learnPack(contents, pack, memory)).toBe(false)
    expect((await contents.load(pack.artifact.sha512))?.leftOut).toEqual([])
  })
})

async function fixture(h: Harness, cdn: Cdn, name: string) {
  const dependency = cdn.file(`equator-${name}`)
  const client = cdn.file(`fancymenu-${name}`)
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: name,
    name,
    dependencies: { minecraft: '26.3', 'fabric-loader': '0.19.5' },
    files: [
      { path: 'mods/fancymenu.jar', file: client, server: 'required' },
      { path: 'mods/equator.jar', file: dependency, server: 'unsupported' },
    ].map(({ path, file, server }) => ({
      path,
      hashes: {
        sha512: file.sha512,
        sha1: createHash('sha1')
          .update(cdn.files.get(new URL(file.url).pathname) ?? Buffer.alloc(0))
          .digest('hex'),
      },
      env: { client: 'required', server },
      downloads: [file.url],
      fileSize: file.sizeBytes,
    })),
  }
  const published = cdn.publish(
    name,
    Buffer.from(zipBytes({ 'modrinth.index.json': utf8(JSON.stringify(index)) })),
  )
  const pack: PinnedModpack = {
    catalog: 'modrinth',
    projectId: name,
    versionId: name,
    name,
    versionLabel: name,
    artifact: published.artifact,
    page: null,
    environment: 'both',
    icon: null,
  }
  const contents = new PackContents({
    db: h.db,
    formats: new LibraryFileFormats(),
    catalog: h.catalog,
    jarChecks: h.app.jarChecks,
  })
  if (pack.artifact.ref.kind !== 'remote') throw new Error('CDN pack is not remote')
  expect((await contents.ofCatalog({ url: pack.artifact.ref.url, sha512: pack.artifact.sha512 })).kind).toBe(
    'read',
  )
  return { contents, pack, dependency }
}

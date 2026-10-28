// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The jars an uploaded pack keeps, held to the checks an uploaded jar gets (`mods/jar-checks.ts`):
 * one a list names by its digest or a signature matches refuses the pack, wherever the pack places
 * it, and one a list names by its digest after the pack was built comes off its servers at their
 * next start. Every jar here is built in the test; none is real malware.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import type { PackImportView } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { FakeMalwareLists } from '../../testing/malware.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { classFile, fabricJar, unzipBytes, utf8, zipBytes } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'

const digest = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('hex')
/** A Fabric mod for Minecraft 1.21.1 whose one class is a whole class file. */
const mod = (id: string) =>
  zipBytes({
    ...unzipBytes(fabricJar(id, { depends: { minecraft: '1.21.1' } })),
    [`net/example/${id}/Mod.class`]: classFile({ name: `net/example/${id}/Mod` }),
  })

/** A plugin jar whose one class is a whole class file, holding `strings`. */
const plugin = (id: string, strings: string[] = []) =>
  zipBytes({
    'plugin.yml': utf8(`name: ${id}\nmain: net.example.${id}.Plugin\nversion: 1.0\n`),
    [`net/example/${id}/Plugin.class`]: classFile({ name: `net/example/${id}/Plugin`, strings }),
  })
const unique = (name: string) => `${name}${randomUUID().slice(0, 6)}`

let h: Harness
const store = new MemoryStore()
const cdn = new Cdn()
const malware = new FakeMalwareLists()

beforeAll(async () => {
  if (!hasDatabase) return
  await store.start()
  await cdn.start()
  h = await startHarness({ capabilities: { archives: store, billing: null, malware } })
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  store.close()
  cdn.close()
})

beforeEach(async () => {
  malware.entries = []
  if (hasDatabase) await h.app.jarChecks.refresh()
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

const checkOf = async (bytes: Uint8Array) =>
  (
    await h.db
      .select()
      .from(schema.jarChecks)
      .where(eq(schema.jarChecks.sha512, digest('sha512', bytes)))
  )[0]

describe.skipIf(!hasDatabase)('the jars an uploaded pack keeps', () => {
  test('one a list names by its digest refuses the pack', async () => {
    const owner = await h.user('Ada', 'plus')
    const bad = mod(`bad${randomUUID().slice(0, 6)}`)
    malware.entries = [{ kind: 'sha1', value: digest('sha1', bad), family: 'Example' }]
    await h.app.jarChecks.refresh()
    const view = await upload(
      owner,
      zipBytes({ 'mods/good.jar': mod(`good${randomUUID().slice(0, 6)}`), 'mods/bad.jar': bad }),
      'Two Mods.zip',
    )
    expect(view).toMatchObject({
      status: 'refused',
      message:
        'This pack holds bad.jar, which matches known malware, so Cubepals won’t build a server from it.',
    })
    expect(await checkOf(bad)).toMatchObject({ state: 'quarantined' })
  }, 60_000)

  test('one whose class a signature matches, in a jar it carries, refuses the pack', async () => {
    const owner = await h.user('Bea', 'plus')
    malware.entries = [{ kind: 'string', value: '==cmds1', family: 'Example' }]
    await h.app.jarChecks.refresh()
    const id = `sig${randomUUID().slice(0, 6)}`
    const library = zipBytes({
      'net/example/Lib.class': classFile({ name: 'net/example/Lib', strings: ['==cmds1'] }),
    })
    const carrying = zipBytes({ ...unzipBytes(mod(id)), 'META-INF/jars/library.jar': library })
    const view = await upload(owner, zipBytes({ 'mods/carrying.jar': carrying }), 'Signed.zip')
    expect(view).toMatchObject({ status: 'refused' })
    expect(await checkOf(carrying)).toMatchObject({
      state: 'quarantined',
      finding: { match: '==cmds1', family: 'Example', source: 'test-list' },
    })
  }, 60_000)

  test('a clean one builds, and comes off its servers at the next start once a list names it', async () => {
    const owner = await h.user('Cai', 'plus')
    const alpha = mod(`alpha${randomUUID().slice(0, 6)}`)
    const beta = mod(`beta${randomUUID().slice(0, 6)}`)
    const view = await upload(
      owner,
      zipBytes({ 'mods/alpha.jar': alpha, 'mods/beta.jar': beta, 'config/alpha.toml': utf8('on = true\n') }),
      'Weekend Mods.zip',
    )
    if (view.status !== 'ready') throw new Error(`Refused: ${view.status === 'refused' ? view.message : ''}`)
    expect(await checkOf(alpha)).toMatchObject({ state: 'clean', sha1: digest('sha1', alpha) })
    const server = await h.create(owner, { from: { kind: 'import', importId: view.importId } })
    const before = (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    expect(before.MODRINTH_OVERRIDES_EXCLUSIONS).toBeUndefined()

    malware.entries = [{ kind: 'sha1', value: digest('sha1', alpha), family: 'Example' }]
    await h.app.jarChecks.refresh()
    const after = (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    expect(after.MODRINTH_OVERRIDES_EXCLUSIONS?.split('\n')).toEqual(['mods/alpha.jar'])
  }, 60_000)

  test('one it places outside its mods, a list names by its digest, refuses the pack', async () => {
    const owner = await h.user('Dov', 'plus')
    const bad = plugin(unique('bad'))
    malware.entries = [{ kind: 'sha512', value: digest('sha512', bad), family: 'Example' }]
    await h.app.jarChecks.refresh()
    const view = await upload(
      owner,
      zipBytes({ 'mods/good.jar': mod(unique('good')), 'plugins/bad.jar': bad }),
      'With Plugin.zip',
    )
    expect(view).toMatchObject({
      status: 'refused',
      message:
        'This pack holds bad.jar, which matches known malware, so Cubepals won’t build a server from it.',
    })
  }, 60_000)
})

describe.skipIf(!hasDatabase)('the jars an uploaded pack keeps, as the lists change', () => {
  test('one it lists and one outside its mods get checks, and come off at the next start once a list names them', async () => {
    const owner = await h.user('Eda', 'plus')
    const listed = mod(unique('listed'))
    const helper = plugin(unique('helper'))
    const download = cdn.publish(unique('listed'), Buffer.from(listed)).artifact.ref
    if (download.kind !== 'remote') throw new Error('The test CDN published no URL')
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '1.0',
      name: 'Listed Pack',
      files: [
        {
          path: 'mods/listed.jar',
          hashes: { sha1: digest('sha1', listed), sha512: digest('sha512', listed) },
          env: { client: 'required', server: 'required' },
          downloads: [download.url],
          fileSize: listed.length,
        },
      ],
      dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
    }
    const view = await upload(
      owner,
      zipBytes({
        'modrinth.index.json': utf8(JSON.stringify(index)),
        'overrides/plugins/helper.jar': helper,
      }),
      'Listed Pack.mrpack',
    )
    if (view.status !== 'ready') throw new Error(`Refused: ${view.status === 'refused' ? view.message : ''}`)
    // The listed jar is looked up by its digests only, and kept by its sha512 alone, since no
    // catalog vouches for the sha1 the pack gives; the carried one is read whole.
    expect(await checkOf(listed)).toMatchObject({ state: 'clean', sha1: null, checkedAt: null })
    expect(await checkOf(helper)).toMatchObject({ state: 'clean', checkedAt: expect.any(Date) })
    const server = await h.create(owner, { from: { kind: 'import', importId: view.importId } })
    const before = (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    expect(before.MODRINTH_OVERRIDES_EXCLUSIONS).toBeUndefined()

    malware.entries = [
      { kind: 'sha512', value: digest('sha512', listed), family: 'Example' },
      { kind: 'sha512', value: digest('sha512', helper), family: 'Example' },
    ]
    await h.app.jarChecks.refresh()
    expect(await checkOf(listed)).toMatchObject({ state: 'quarantined' })
    expect(await checkOf(helper)).toMatchObject({ state: 'quarantined' })
    const after = (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    // The listed one by the pack's index, the carried one by its overrides.
    expect(after.MODRINTH_EXCLUDE_FILES).toContain('listed')
    expect(after.MODRINTH_OVERRIDES_EXCLUSIONS?.split('\n').sort()).toEqual([
      'mods/listed.jar',
      'plugins/helper.jar',
    ])
  }, 60_000)

  test('one a new signature matches keeps its answer until a pack carrying it is next built', async () => {
    const owner = await h.user('Fin', 'plus')
    const marker = `==${randomUUID().slice(0, 8)}`
    const odd = zipBytes({
      ...unzipBytes(mod(unique('odd'))),
      'net/example/Odd.class': classFile({ name: 'net/example/Odd', strings: [marker] }),
    })
    const pack = zipBytes({ 'mods/odd.jar': odd })
    const first = await upload(owner, pack, 'Odd Mods.zip')
    expect(first).toMatchObject({ status: 'ready' })
    expect(await checkOf(odd)).toMatchObject({ state: 'clean', checkedAt: expect.any(Date) })

    malware.entries = [{ kind: 'string', value: marker, family: 'Example' }]
    await h.app.jarChecks.refresh()
    expect(await checkOf(odd)).toMatchObject({ state: 'clean', checkedAt: null })
    expect(await upload(owner, pack, 'Odd Mods.zip')).toMatchObject({ status: 'refused' })
    expect(await checkOf(odd)).toMatchObject({ state: 'quarantined', finding: { match: marker } })
  }, 60_000)
})

describe.skipIf(!hasDatabase)(
  'the jars an uploaded pack keeps, by what it says and what was kept before',
  () => {
    test('a pack giving a jar a digest a list names is refused, and the jar it claims to be is not touched', async () => {
      const owner = await h.user('Hal', 'plus')
      const popular = mod(unique('popular'))
      const download = cdn.publish(unique('popular'), Buffer.from(popular)).artifact.ref
      if (download.kind !== 'remote') throw new Error('The test CDN published no URL')
      // Another owner's server runs the jar already, read whole.
      const other = await upload(
        await h.user('Ida', 'plus'),
        zipBytes({ 'mods/popular.jar': popular }),
        'Mine.zip',
      )
      expect(other).toMatchObject({ status: 'ready' })
      const bad = '0'.repeat(40)
      malware.entries = [{ kind: 'sha1', value: bad, family: 'Example' }]
      await h.app.jarChecks.refresh()
      const index = {
        formatVersion: 1,
        game: 'minecraft',
        versionId: '1.0',
        name: 'Claiming Pack',
        files: [
          {
            path: 'mods/popular.jar',
            hashes: { sha1: bad, sha512: digest('sha512', popular) },
            env: { client: 'required', server: 'required' },
            downloads: [download.url],
            fileSize: popular.length,
          },
        ],
        dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
      }
      const view = await upload(
        owner,
        zipBytes({ 'modrinth.index.json': utf8(JSON.stringify(index)) }),
        'Claiming Pack.mrpack',
      )
      expect(view).toMatchObject({ status: 'refused' })
      expect(await checkOf(popular)).toMatchObject({ state: 'clean', sha1: digest('sha1', popular) })
    }, 60_000)

    test('a pack kept before its jars outside the mods were read gets them when it is uploaded again', async () => {
      const owner = await h.user('Gil', 'plus')
      const helper = plugin(unique('helper'))
      const pack = zipBytes({ 'mods/good.jar': mod(unique('good')), 'plugins/helper.jar': helper })
      const first = await upload(owner, pack, 'Kept Pack.zip')
      if (first.status !== 'ready') throw new Error('The pack was refused')
      // As a pack built before these jars were read was kept: none of them, and no check of its own.
      const [built] = await h.db
        .select({ sha512: schema.packImports.packSha512 })
        .from(schema.packImports)
        .where(eq(schema.packImports.id, first.importId))
      const sha512 = built?.sha512 ?? ''
      await h.db
        .update(schema.packContents)
        .set({ otherJars: [] })
        .where(eq(schema.packContents.sha512, sha512))
      await h.db.delete(schema.jarChecks).where(eq(schema.jarChecks.sha512, digest('sha512', helper)))

      const again = await upload(owner, pack, 'Kept Pack.zip')
      if (again.status !== 'ready') throw new Error('The pack was refused')
      const [row] = await h.db
        .select({ otherJars: schema.packContents.otherJars })
        .from(schema.packContents)
        .where(eq(schema.packContents.sha512, sha512))
      expect(row?.otherJars.map((jar) => jar.path)).toEqual(['plugins/helper.jar'])
      expect(await checkOf(helper)).toMatchObject({ state: 'clean' })

      const server = await h.create(owner, { from: { kind: 'import', importId: again.importId } })
      malware.entries = [{ kind: 'sha512', value: digest('sha512', helper), family: 'Example' }]
      await h.app.jarChecks.refresh()
      const after = (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
      expect(after.MODRINTH_OVERRIDES_EXCLUSIONS?.split('\n')).toContain('plugins/helper.jar')
    }, 60_000)
  },
)

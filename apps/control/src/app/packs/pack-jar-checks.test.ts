// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The jars an uploaded pack keeps, held to the checks an uploaded jar gets (`mods/jar-checks.ts`):
 * one a list names by its digest or a signature matches refuses the pack, wherever the pack places
 * it, and one a list names by its digest after the pack was built comes off its servers at their
 * next start, its owners told. A jar a pack left out that a start finds another mod needs is held
 * to the same checks before it runs, and after. Every jar here is built in the test; none is real
 * malware.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
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
import { loadPackContents } from './persistence.ts'

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
/** A Fabric mod that says it runs only in players' games. */
const clientMod = (id: string) =>
  zipBytes({
    ...unzipBytes(fabricJar(id, { environment: 'client', depends: { minecraft: '1.21.1' } })),
    [`net/example/${id}/Mod.class`]: classFile({ name: `net/example/${id}/Mod` }),
  })

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

afterEach(() => {
  if (hasDatabase) h.minecraft.breakOn(() => null)
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

  test('a clean one builds, and comes off its servers at the next start once a list names it, its owner told', async () => {
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
    // Its owner is told, as for a mod of their own.
    const [told] = h.mail.to(`${owner.userId}@example.test`)
    expect(told?.subject).toStartWith('We’re taking alpha.jar off ')
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

  test('one a new signature matches keeps its answer until a pack carrying it is next built, then its servers’ owners are told', async () => {
    const owner = await h.user('Fin', 'plus')
    const marker = `==${randomUUID().slice(0, 8)}`
    const odd = zipBytes({
      ...unzipBytes(mod(unique('odd'))),
      'net/example/Odd.class': classFile({ name: 'net/example/Odd', strings: [marker] }),
    })
    const pack = zipBytes({ 'mods/odd.jar': odd })
    const first = await upload(owner, pack, 'Odd Mods.zip')
    if (first.status !== 'ready') throw new Error('The pack was refused')
    expect(await checkOf(odd)).toMatchObject({ state: 'clean', checkedAt: expect.any(Date) })
    const server = await h.create(owner, { from: { kind: 'import', importId: first.importId } })

    malware.entries = [{ kind: 'string', value: marker, family: 'Example' }]
    await h.app.jarChecks.refresh()
    expect(await checkOf(odd)).toMatchObject({ state: 'clean', checkedAt: null })
    expect(h.mail.to(`${owner.userId}@example.test`)).toEqual([])
    expect(await upload(owner, pack, 'Odd Mods.zip')).toMatchObject({ status: 'refused' })
    expect(await checkOf(odd)).toMatchObject({ state: 'quarantined', finding: { match: marker } })
    // The server that runs it already comes off it at its next start, and its owner is told.
    const [told] = h.mail.to(`${owner.userId}@example.test`)
    expect(told?.subject).toStartWith('We’re taking odd.jar off ')
    const after = (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    expect(after.MODRINTH_OVERRIDES_EXCLUSIONS?.split('\n')).toEqual(['mods/odd.jar'])
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

/**
 * A catalog pack whose index keeps `lib` off servers, which its own mod needs: a server of it
 * stops as it starts until the pack's servers install the library anyway.
 */
const packNeeding = (lib: string) => {
  const core = cdn.file(`${lib}-core-1`, fabricJar(`${lib}core`, { depends: { minecraft: '1.21.1' } }))
  const library = cdn.file(`${lib}-2.5.3`, fabricJar(lib, { depends: { minecraft: '1.21.1' } }))
  const entry = (path: string, file: typeof core, server: string) => ({
    path,
    hashes: { sha1: 'a'.repeat(40), sha512: file.sha512 },
    env: { client: 'required', server },
    downloads: [file.url],
    fileSize: file.sizeBytes,
  })
  const path = `mods/${lib}-2.5.3.jar`
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.0',
    name: `${lib} pack`,
    files: [entry(`mods/${lib}-core-1.jar`, core, 'required'), entry(path, library, 'unsupported')],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
  }
  const pack = cdn.file(`${lib}-pack`, zipBytes({ 'modrinth.index.json': utf8(JSON.stringify(index)) }))
  const project = { projectId: `${lib}-pack`, slug: `${lib}-pack`, name: `${lib} pack`, summary: '' }
  h.catalog.publishModpack(
    { ...project, iconUrl: null, environments: ['client_and_server'], downloads: 1, categories: [] },
    [
      {
        versionId: `${lib}-1`,
        projectId: project.projectId,
        versionLabel: '1.0',
        channel: 'release',
        state: 'listed',
        environment: 'client_and_server',
        loaders: ['fabric'],
        gameVersions: ['1.21.1'],
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file: pack,
        dependencies: [],
      },
    ],
  )
  h.minecraft.breakOn((env) =>
    (env.MODRINTH_FORCE_INCLUDE_FILES ?? '').includes(lib)
      ? null
      : [
          'Some of your mods are incompatible',
          `${lib} core requires version [2.5.3, ∞) of ${lib}, which is missing!`,
        ].join('\n'),
  )
  return { projectId: project.projectId, pack, library, path }
}

describe.skipIf(!hasDatabase)('a jar a pack keeps off servers, which a mod of it needs', () => {
  test('one a list names is not installed after all', async () => {
    const needed = packNeeding('equinox')
    malware.entries = [{ kind: 'sha512', value: needed.library.sha512, family: 'Example' }]
    await h.app.jarChecks.refresh()
    const owner = await h.user('Jo', 'plus')
    const server = await h.create(owner, { from: { kind: 'modpack', projectId: needed.projectId } })
    await h.settled(server.id, 30_000)
    expect((await h.server(server.id)).lifecycle.status).not.toBe('running')
    expect(await h.minecraft.file(server.id, needed.path)).toBeNull()
    expect((await loadPackContents(h.db, needed.pack.sha512))?.leftOut ?? []).toEqual([])
    const env = (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    expect(env.MODRINTH_FORCE_INCLUDE_FILES).toBeUndefined()
  }, 60_000)

  test('one installed comes off at the next start once a list names it, its owner told', async () => {
    const needed = packNeeding('solstice')
    const owner = await h.user('Kit', 'plus')
    const server = await h.create(owner, { from: { kind: 'modpack', projectId: needed.projectId } })
    await h.settled(server.id, 30_000)
    expect((await h.server(server.id)).lifecycle).toMatchObject({ status: 'running' })
    expect(await h.minecraft.file(server.id, needed.path)).not.toBeNull()
    expect((await loadPackContents(h.db, needed.pack.sha512))?.leftOut).toEqual([
      { path: needed.path, why: 'needed', sha512: needed.library.sha512 },
    ])
    const before = (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    expect(before.MODRINTH_FORCE_INCLUDE_FILES).toContain('solstice')

    malware.entries = [{ kind: 'sha512', value: needed.library.sha512, family: 'Example' }]
    await h.app.jarChecks.refresh()
    const after = (await h.app.specs.desired(h.db, await h.server(server.id))).spec.env
    expect(after.MODRINTH_FORCE_INCLUDE_FILES).toBeUndefined()
    expect(after.MODRINTH_EXCLUDE_FILES).toContain('solstice')
    const [told] = h.mail.to(`${owner.userId}@example.test`)
    expect(told?.subject).toStartWith('We’re taking solstice-2.5.3.jar off ')
  }, 60_000)
})

/**
 * A catalog pack listing `lib`, which the catalog says runs only in players' games, beside a mod
 * that needs it: a server of it stops as it starts while the library is left out.
 */
const packForPlayers = (lib: string) => {
  const library = cdn.file(`${lib}-1`, fabricJar(lib, { depends: { minecraft: '1.21.1' } }))
  const user = cdn.file(`${lib}-user-1`, fabricJar(`${lib}user`, { depends: { minecraft: '1.21.1' } }))
  const version = {
    channel: 'release' as const,
    state: 'listed' as const,
    loaders: ['fabric'],
    gameVersions: ['1.21.1'],
    publishedAt: new Date(Date.UTC(2026, 0, 1)),
    dependencies: [],
  }
  const project = { slug: lib, name: lib, summary: '', iconUrl: null, downloads: 1 }
  h.catalog.publish({ ...project, projectId: lib, environments: ['client_only'] }, [
    {
      ...version,
      versionId: `${lib}-1`,
      projectId: lib,
      versionLabel: '1',
      environment: 'client_only',
      file: library,
    },
  ])
  const entry = (path: string, file: typeof library) => ({
    path,
    hashes: { sha1: 'a'.repeat(40), sha512: file.sha512 },
    env: { client: 'required', server: 'required' },
    downloads: [file.url],
    fileSize: file.sizeBytes,
  })
  const path = `mods/${lib}-1.jar`
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.0',
    name: `${lib} pack`,
    files: [entry(`mods/${lib}-user-1.jar`, user), entry(path, library)],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
  }
  const pack = cdn.file(`${lib}-pack`, zipBytes({ 'modrinth.index.json': utf8(JSON.stringify(index)) }))
  const projectId = `${lib}-pack`
  h.catalog.publishModpack({ ...project, projectId, environments: ['client_and_server'], categories: [] }, [
    {
      ...version,
      versionId: `${lib}-pack-1`,
      projectId,
      versionLabel: '1.0',
      environment: 'client_and_server',
      file: pack,
    },
  ])
  const breaks = () =>
    h.minecraft.breakOn((env) =>
      (env.MODRINTH_EXCLUDE_FILES ?? '').includes(lib)
        ? [
            'Incompatible mods found!',
            `\t - Mod '${lib} user' (${lib}user) 1.0.0 requires any version of ${lib}, which is missing!`,
          ].join('\n')
        : null,
    )
  return { projectId, pack, library, path, breaks }
}

describe.skipIf(!hasDatabase)('a jar Blockly left out for players, which a mod of the pack needs', () => {
  test('one a list names is not put back', async () => {
    const lib = packForPlayers('vernal')
    lib.breaks()
    malware.entries = [{ kind: 'sha512', value: lib.library.sha512, family: 'Example' }]
    await h.app.jarChecks.refresh()
    const owner = await h.user('Lee', 'plus')
    const server = await h.create(owner, { from: { kind: 'modpack', projectId: lib.projectId } })
    await h.settled(server.id, 30_000)
    expect((await h.server(server.id)).lifecycle.status).not.toBe('running')
    expect(await h.minecraft.file(server.id, lib.path)).toBeNull()
    expect((await loadPackContents(h.db, lib.pack.sha512))?.leftOut).toEqual([
      { path: lib.path, why: 'players', sha512: lib.library.sha512 },
    ])
  }, 60_000)

  test('one kept before its sha512 was, a list names, is found by the pack’s index and not put back', async () => {
    const lib = packForPlayers('autumnal')
    const owner = await h.user('Mae', 'plus')
    const server = await h.create(owner, { from: { kind: 'modpack', projectId: lib.projectId } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    // As a row kept before left-out jars had their sha512.
    await h.db
      .update(schema.packContents)
      .set({ leftOut: [{ path: lib.path, why: 'players' }] })
      .where(eq(schema.packContents.sha512, lib.pack.sha512))
    malware.entries = [{ kind: 'sha512', value: lib.library.sha512, family: 'Example' }]
    await h.app.jarChecks.refresh()
    lib.breaks()
    await h.app.servers.stop(owner, server.id, randomUUID())
    await h.until(server.id, 'stopped')
    await h.app.servers.start(owner, server.id, randomUUID())
    await h.settled(server.id, 30_000)
    expect((await h.server(server.id)).lifecycle.status).not.toBe('running')
    expect((await loadPackContents(h.db, lib.pack.sha512))?.leftOut).toEqual([
      { path: lib.path, why: 'players' },
    ])
  }, 60_000)
})

describe.skipIf(!hasDatabase)('a pack kept before its left-out jars had their sha512', () => {
  test('gets them when it is uploaded again, each entry keeping what it learned', async () => {
    const owner = await h.user('Ned', 'plus')
    const minimap = clientMod(unique('minimap'))
    const shaders = clientMod(unique('shaders'))
    const pack = zipBytes({
      'mods/good.jar': mod(unique('good')),
      'mods/minimap.jar': minimap,
      'mods/shaders.jar': shaders,
    })
    const first = await upload(owner, pack, 'Old Pack.zip')
    if (first.status !== 'ready') throw new Error('The pack was refused')
    const [built] = await h.db
      .select({ sha512: schema.packImports.packSha512 })
      .from(schema.packImports)
      .where(eq(schema.packImports.id, first.importId))
    const sha512 = built?.sha512 ?? ''
    // As kept before: no sha512, and one of them learned since to be needed.
    const players = { path: 'mods/minimap.jar', why: 'players' as const }
    const needed = { path: 'mods/shaders.jar', why: 'needed' as const }
    await h.db
      .update(schema.packContents)
      .set({ leftOut: [players, needed] })
      .where(eq(schema.packContents.sha512, sha512))

    expect(await upload(owner, pack, 'Old Pack.zip')).toMatchObject({ status: 'ready' })
    expect((await loadPackContents(h.db, sha512))?.leftOut).toEqual([
      { ...players, sha512: digest('sha512', minimap) },
      { ...needed, sha512: digest('sha512', shaders) },
    ])
  }, 60_000)
})

describe.skipIf(!hasDatabase)('the owner of a server running a jar both as a mod and in its pack', () => {
  test('is told once', async () => {
    const owner = await h.user('Ola', 'plus')
    const both = mod(unique('both'))
    const view = await upload(owner, zipBytes({ 'mods/both.jar': both }), 'Both Ways.zip')
    if (view.status !== 'ready') throw new Error('The pack was refused')
    const server = await h.create(owner, { from: { kind: 'import', importId: view.importId } })
    // A revision written here pins it as a mod too, which a pack server's own changes never do.
    await h.db
      .update(schema.serverRevisions)
      .set({ mods: [cdn.publish(unique('both'), Buffer.from(both))] })
      .where(eq(schema.serverRevisions.id, (await h.server(server.id)).desiredRevisionId))
    malware.entries = [{ kind: 'sha512', value: digest('sha512', both), family: 'Example' }]
    await h.app.jarChecks.refresh()
    const told = h.mail.to(`${owner.userId}@example.test`).filter((m) => m.subject.startsWith('We’re taking'))
    expect(told).toHaveLength(1)
  }, 60_000)
})

describe.skipIf(!hasDatabase)('the jars an uploaded pack leaves to players’ games', () => {
  test('one it carries, a list names by its digest, refuses the pack', async () => {
    const owner = await h.user('Max', 'plus')
    const bad = clientMod(unique('minimap'))
    malware.entries = [{ kind: 'sha1', value: digest('sha1', bad), family: 'Example' }]
    await h.app.jarChecks.refresh()
    const view = await upload(
      owner,
      zipBytes({ 'mods/good.jar': mod(unique('good')), 'mods/minimap.jar': bad }),
      'With Minimap.zip',
    )
    expect(view).toMatchObject({
      status: 'refused',
      message:
        'This pack holds minimap.jar, which matches known malware, so Cubepals won’t build a server from it.',
    })
  }, 60_000)

  test('one it lists, a list names by its digest, refuses the pack', async () => {
    const owner = await h.user('Ned', 'plus')
    const bad = clientMod(unique('zoom'))
    malware.entries = [{ kind: 'sha512', value: digest('sha512', bad), family: 'Example' }]
    await h.app.jarChecks.refresh()
    const view = await upload(owner, listing(bad, 'mods/zoom.jar', 'zoom'), 'Listed Zoom.mrpack')
    expect(view).toMatchObject({
      status: 'refused',
      message:
        'This pack holds zoom.jar, which matches known malware, so Cubepals won’t build a server from it.',
    })
  }, 60_000)

  test('ones no list names are kept with their sha512, checked', async () => {
    const owner = await h.user('Oda', 'plus')
    const carried = clientMod(unique('shaders'))
    const listed = clientMod(unique('hud'))
    const view = await upload(
      owner,
      zipBytes({
        ...unzipBytes(listing(listed, 'mods/hud.jar', 'hud')),
        'overrides/mods/shaders.jar': carried,
      }),
      'Pretty Pack.mrpack',
    )
    if (view.status !== 'ready') throw new Error(`Refused: ${view.status === 'refused' ? view.message : ''}`)
    const [built] = await h.db
      .select({ sha512: schema.packImports.packSha512 })
      .from(schema.packImports)
      .where(eq(schema.packImports.id, view.importId))
    const leftOut = (await loadPackContents(h.db, built?.sha512 ?? ''))?.leftOut ?? []
    expect(leftOut).toContainEqual({ path: 'mods/hud.jar', why: 'players', sha512: digest('sha512', listed) })
    expect(leftOut).toContainEqual({
      path: 'mods/shaders.jar',
      why: 'players',
      sha512: digest('sha512', carried),
    })
    expect(await checkOf(carried)).toMatchObject({ state: 'clean', checkedAt: expect.any(Date) })
    expect(await checkOf(listed)).toMatchObject({ state: 'clean', checkedAt: null })
  }, 60_000)
})

/**
 * A Modrinth pack listing `bytes` at `path`, which the catalog publishes as for players' games
 * alone, beside one mod it carries for servers.
 */
const listing = (bytes: Uint8Array, path: string, project: string) => {
  const id = unique(project)
  const file = cdn.file(id, bytes)
  h.catalog.publish(
    {
      projectId: id,
      slug: id,
      name: id,
      summary: '',
      iconUrl: null,
      environments: ['client_only'],
      downloads: 1,
    },
    [
      {
        versionId: `${id}-1`,
        projectId: id,
        versionLabel: '1',
        channel: 'release',
        state: 'listed',
        environment: 'client_only',
        loaders: ['fabric'],
        gameVersions: ['1.21.1'],
        publishedAt: new Date(Date.UTC(2026, 0, 1)),
        file,
        dependencies: [],
      },
    ],
  )
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.0',
    name: 'Listing Pack',
    files: [
      {
        path,
        hashes: { sha1: digest('sha1', bytes), sha512: file.sha512 },
        env: { client: 'required', server: 'required' },
        downloads: [file.url],
        fileSize: file.sizeBytes,
      },
    ],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
  }
  return zipBytes({
    'modrinth.index.json': utf8(JSON.stringify(index)),
    'overrides/mods/core.jar': mod(unique('core')),
  })
}

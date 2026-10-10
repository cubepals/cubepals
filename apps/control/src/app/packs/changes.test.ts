// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { fabricJar, utf8, zipBytes } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import { loadRevision } from '../servers/persistence.ts'
import { loadPackContents } from './persistence.ts'

// A pack changes like a deployment (docs/modpack-system.md § Installing): a newer version is
// offered, never applied by itself; moving to it takes a restore point, and a version that doesn't
// start puts the one before back, whether the server was running or starts onto the change.
describe.skipIf(!hasDatabase)('pack changes', () => {
  let h: Harness
  const cdn = new Cdn()

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)

  afterEach(() => h.minecraft.breakOn(() => null))

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  /** One version of the pack, whose single mod is published beside it. */
  const release = (n: number): CatalogVersion => {
    const mod = cdn.file(`farm-${n}`, fabricJar(`farm${n}`, { depends: { minecraft: '1.21.1' } }))
    const pack = cdn.file(
      `update-pack-${n}`,
      zipBytes({
        'modrinth.index.json': utf8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: `${n}.0`,
            name: 'Update Pack',
            files: [
              {
                path: `mods/farm-${n}.jar`,
                hashes: { sha1: 'a'.repeat(40), sha512: mod.sha512 },
                env: { client: 'required', server: 'required' },
                downloads: [mod.url],
                fileSize: mod.sizeBytes,
              },
            ],
            dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
          }),
        ),
        'overrides/config/farm.toml': utf8(`version = ${n}\n`),
      }),
    )
    return {
      versionId: `update-${n}`,
      projectId: 'update-pack',
      versionLabel: `${n}.0`,
      channel: 'release',
      state: 'listed',
      environment: 'client_and_server',
      loaders: ['fabric'],
      gameVersions: ['1.21.1'],
      publishedAt: new Date(Date.UTC(2026, 0, n)),
      file: pack,
      dependencies: [],
    }
  }
  const releases: CatalogVersion[] = []
  const publish = (n: number) => {
    releases.unshift(release(n))
    h.catalog.publishModpack(
      {
        projectId: 'update-pack',
        slug: 'update-pack',
        name: 'Update Pack',
        summary: 'For tests',
        iconUrl: null,
        environments: ['client_and_server'],
        downloads: 1,
        categories: [],
      },
      [...releases],
    )
    return releases[0] as CatalogVersion
  }
  const packOf = async (id: string) =>
    (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).modpack
  const changeTo = async (owner: UserActor, id: string, versionId: string) =>
    h.app.packChanges.change(owner, id, { kind: 'catalog', versionId }, randomUUID(), {
      version: (await h.server(id)).version,
    })

  test('an update is offered, applied with a restore point, and a version that doesn’t start is undone', async () => {
    publish(1)
    const owner = await h.user('Pat', 'plus')
    const server = await h.create(owner, { from: { kind: 'modpack', projectId: 'update-pack' } })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect(await h.minecraft.file(server.id, 'mods/farm-1.jar')).not.toBeNull()

    // A newer version is offered, and nothing moves by itself.
    publish(2)
    const offered = await h.app.modQueries.list(owner, server.id)
    expect(offered.packUpdate).toEqual({
      versionId: 'update-2',
      label: '2.0',
      gameVersion: '1.21.1',
      movesWorld: false,
      // A catalog pack names its catalog version; only a curated one names a release.
      release: null,
    })
    expect((await packOf(server.id))?.versionId).toBe('update-1')

    // Moving to it: a snapshot first, then the new pack, with the old one's files gone.
    await changeTo(owner, server.id, 'update-2')
    await h.until(server.id, 'running')
    await h.settled(server.id)
    expect((await packOf(server.id))?.versionId).toBe('update-2')
    expect(await h.minecraft.file(server.id, 'mods/farm-2.jar')).not.toBeNull()
    expect(await h.minecraft.file(server.id, 'mods/farm-1.jar')).toBeNull()
    expect(await h.minecraft.file(server.id, 'config/farm.toml')).toBe('version = 2\n')
    const restorePoints = (await listBackups(h.db, server.id)).filter((b) => b.trigger === 'pre_apply')
    expect(restorePoints.length).toBeGreaterThanOrEqual(1)

    // A version that doesn't start: the one before comes back, files and all, still running.
    const broken = publish(3)
    h.minecraft.breakOn((env) =>
      env.BLOCKLY_PACK === broken.file.sha512.slice(0, 32) ? 'a mod of it crashed' : null,
    )
    await changeTo(owner, server.id, 'update-3')
    await h.settled(server.id)
    expect((await h.server(server.id)).lifecycle.status).toBe('running')
    expect((await packOf(server.id))?.versionId).toBe('update-2')
    expect(await h.minecraft.file(server.id, 'config/farm.toml')).toBe('version = 2\n')
    const [last] = (await h.operations(server.id)).filter((op) => op.kind === 'apply').reverse()
    expect(last?.status).toBe('failed')
    expect(last?.error).toContain('Your server is back on the one before.')
  }, 90_000)

  test('a change made while stopped installs as the server starts, and goes back if it doesn’t', async () => {
    const owner = await h.user('Quinn', 'plus')
    const server = await h.create(owner, {
      from: { kind: 'modpack', projectId: 'update-pack', versionId: 'update-2' },
    })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(owner, server.id, randomUUID())
    await h.until(server.id, 'stopped')
    await h.settled(server.id)

    const broken = releases.find((r) => r.versionId === 'update-3') as CatalogVersion
    h.minecraft.breakOn((env) =>
      env.BLOCKLY_PACK === broken.file.sha512.slice(0, 32) ? 'a mod of it crashed' : null,
    )
    await changeTo(owner, server.id, 'update-3')
    // Stopped, it waits for the start.
    expect((await h.server(server.id)).lifecycle.status).toBe('stopped')
    await h.app.servers.start(owner, server.id, randomUUID())
    await h.settled(server.id)
    // The start happened, on the pack before, and says the new one didn't take.
    expect((await h.server(server.id)).lifecycle.status).toBe('running')
    expect((await packOf(server.id))?.versionId).toBe('update-2')
    const [start] = (await h.operations(server.id)).filter((op) => op.kind === 'start').reverse()
    expect(start?.status).toBe('failed')
    expect(start?.error).toContain('Your server is back on the one before.')
    const restorePoints = (await listBackups(h.db, server.id)).filter((b) => b.trigger === 'pre_apply')
    expect(restorePoints.length).toBeGreaterThanOrEqual(1)
  }, 90_000)

  test('a mod the catalog lets a server run that stops one as it starts is left out, and the start goes on', async () => {
    // Zombie Storm 100 Days, 2026-09-26: Modrinth says Fog Overrides may run on a server; on one,
    // it reaches for the game's screen and stops it. Only the start can tell.
    const farm = cdn.file('farm-fog', fabricJar('farmfog', { depends: { minecraft: '1.21.1' } }))
    const fog = cdn.file('fog-maker-1', fabricJar('fogmaker', { depends: { minecraft: '1.21.1' } }))
    const entry = (path: string, file: typeof farm) => ({
      path,
      hashes: { sha1: 'a'.repeat(40), sha512: file.sha512 },
      env: { client: 'required', server: 'required' },
      downloads: [file.url],
      fileSize: file.sizeBytes,
    })
    const pack = cdn.file(
      'fog-pack',
      zipBytes({
        'modrinth.index.json': utf8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: '1.0',
            name: 'Fog Pack',
            files: [entry('mods/farm-fog.jar', farm), entry('mods/fog-maker-1.jar', fog)],
            dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
          }),
        ),
      }),
    )
    h.catalog.publishModpack(
      {
        projectId: 'fog-pack',
        slug: 'fog-pack',
        name: 'Fog Pack',
        summary: 'For tests',
        iconUrl: null,
        environments: ['client_and_server'],
        downloads: 1,
        categories: [],
      },
      [
        {
          versionId: 'fog-1',
          projectId: 'fog-pack',
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
      (env.MODRINTH_EXCLUDE_FILES ?? '').includes('fog')
        ? null
        : [
            'mod loading failed',
            'Fog Maker (fogmaker) has failed to load correctly',
            '\tjava.lang.RuntimeException: Attempted to load class net/minecraft/client/Minecraft for invalid dist DEDICATED_SERVER',
          ].join('\n'),
    )
    const owner = await h.user('Sol', 'plus')
    const server = await h.create(owner, { from: { kind: 'modpack', projectId: 'fog-pack' } })
    await h.settled(server.id, 30_000)
    expect((await h.server(server.id)).lifecycle).toMatchObject({ status: 'running' })
    expect(await h.minecraft.file(server.id, 'mods/farm-fog.jar')).not.toBeNull()
    expect(await h.minecraft.file(server.id, 'mods/fog-maker-1.jar')).toBeNull()
    // Every server of the pack knows it now, and its owner sees it with the rest left out.
    expect((await loadPackContents(h.db, pack.sha512))?.leftOut).toContainEqual({
      path: 'mods/fog-maker-1.jar',
      why: 'crashed',
    })
    expect((await h.app.modQueries.list(owner, server.id)).packLeftOut).toContain('fog maker')
  }, 60_000)

  test('a mod Blockly left out that another one needs is put back, and the start goes on', async () => {
    // The catalog says the library only runs in players' games; a mod of the pack needs it anyway.
    const library = cdn.file('need-lib-1', fabricJar('needlib', { depends: { minecraft: '1.21.1' } }))
    const user = cdn.file('lib-user-1', fabricJar('libuser', { depends: { minecraft: '1.21.1' } }))
    h.catalog.publish(
      {
        projectId: 'need-lib',
        slug: 'need-lib',
        name: 'Need Lib',
        summary: '',
        iconUrl: null,
        environments: ['client_only'],
        downloads: 1,
      },
      [
        {
          versionId: 'need-lib-1',
          projectId: 'need-lib',
          versionLabel: '1',
          channel: 'release',
          state: 'listed',
          environment: 'client_only',
          loaders: ['fabric'],
          gameVersions: ['1.21.1'],
          publishedAt: new Date(),
          file: library,
          dependencies: [],
        },
      ],
    )
    const entry = (path: string, file: typeof library) => ({
      path,
      hashes: { sha1: 'a'.repeat(40), sha512: file.sha512 },
      env: { client: 'required', server: 'required' },
      downloads: [file.url],
      fileSize: file.sizeBytes,
    })
    const pack = cdn.file(
      'lib-pack',
      zipBytes({
        'modrinth.index.json': utf8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: '1.0',
            name: 'Lib Pack',
            files: [entry('mods/lib-user-1.jar', user), entry('mods/need-lib-1.jar', library)],
            dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
          }),
        ),
      }),
    )
    h.catalog.publishModpack(
      {
        projectId: 'lib-pack',
        slug: 'lib-pack',
        name: 'Lib Pack',
        summary: 'For tests',
        iconUrl: null,
        environments: ['client_and_server'],
        downloads: 1,
        categories: [],
      },
      [
        {
          versionId: 'lib-1',
          projectId: 'lib-pack',
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
      (env.MODRINTH_EXCLUDE_FILES ?? '').includes('need')
        ? [
            'Incompatible mods found!',
            "\t - Mod 'Lib User' (libuser) 1.0.0 requires any version of needlib, which is missing!",
          ].join('\n')
        : null,
    )
    const owner = await h.user('Tam', 'plus')
    const server = await h.create(owner, { from: { kind: 'modpack', projectId: 'lib-pack' } })
    await h.settled(server.id, 30_000)
    expect((await h.server(server.id)).lifecycle).toMatchObject({ status: 'running' })
    expect(await h.minecraft.file(server.id, 'mods/need-lib-1.jar')).not.toBeNull()
    expect((await loadPackContents(h.db, pack.sha512))?.leftOut).toEqual([])
  }, 60_000)

  test('a library the pack itself keeps off servers, which its own mod needs, is installed anyway', async () => {
    // Cabricality 0.3.1 on the real image, 2026-09-26: its index marks Equator unsupported on
    // servers, and the pack's own mod needs it.
    const core = cdn.file('eq-core-1', fabricJar('eqcore', { depends: { minecraft: '1.21.1' } }))
    const equator = cdn.file('equator-2.5.3', fabricJar('equator', { depends: { minecraft: '1.21.1' } }))
    const entry = (path: string, file: typeof core, server: string) => ({
      path,
      hashes: { sha1: 'a'.repeat(40), sha512: file.sha512 },
      env: { client: 'required', server },
      downloads: [file.url],
      fileSize: file.sizeBytes,
    })
    const pack = cdn.file(
      'eq-pack',
      zipBytes({
        'modrinth.index.json': utf8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: '0.3.1',
            name: 'Eq Pack',
            files: [
              entry('mods/eq-core-1.jar', core, 'required'),
              entry('mods/equator-2.5.3.jar', equator, 'unsupported'),
            ],
            dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
          }),
        ),
      }),
    )
    h.catalog.publishModpack(
      {
        projectId: 'eq-pack',
        slug: 'eq-pack',
        name: 'Eq Pack',
        summary: 'For tests',
        iconUrl: null,
        environments: ['client_and_server'],
        downloads: 1,
        categories: [],
      },
      [
        {
          versionId: 'eq-1',
          projectId: 'eq-pack',
          versionLabel: '0.3.1',
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
      (env.MODRINTH_FORCE_INCLUDE_FILES ?? '').includes('equator')
        ? null
        : [
            'Some of your mods are incompatible',
            'Eq Core requires version [2.5.3, ∞) of equator, which is missing!',
          ].join('\n'),
    )
    const owner = await h.user('Uma', 'plus')
    const server = await h.create(owner, { from: { kind: 'modpack', projectId: 'eq-pack' } })
    await h.settled(server.id, 30_000)
    expect((await h.server(server.id)).lifecycle).toMatchObject({ status: 'running' })
    expect(await h.minecraft.file(server.id, 'mods/equator-2.5.3.jar')).not.toBeNull()
    expect((await loadPackContents(h.db, pack.sha512))?.leftOut).toContainEqual({
      path: 'mods/equator-2.5.3.jar',
      why: 'needed',
    })
    // Nothing is said to be left out for players: it's installed.
    expect((await h.app.modQueries.list(owner, server.id)).packLeftOut).toEqual([])
  }, 60_000)

  test('a pack server’s Minecraft and mods change with the pack, never on their own', async () => {
    const owner = await h.user('Rae', 'plus')
    const server = await h.create(owner, {
      from: { kind: 'modpack', projectId: 'update-pack', versionId: 'update-2' },
    })
    await h.until(server.id, 'running')
    const desired = await loadRevision(h.db, (await h.server(server.id)).desiredRevisionId)
    const refused = await h.app.revisions
      .changeMods(owner, server.id, { basedOn: desired.id, mods: [] }, randomUUID())
      .then(
        () => null,
        (error: Error) => error.message,
      )
    expect(refused).toBe(
      'This server plays Update Pack: its Minecraft and its mods come with the pack. Change the pack instead.',
    )
  }, 60_000)
})

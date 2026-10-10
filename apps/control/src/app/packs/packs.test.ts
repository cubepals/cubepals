// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { fabricJar, textOf, unzipBytes, utf8, zipBytes } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'

const sha512 = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('hex')
const sha1 = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex')

// Packs people bring (docs/modpack-system.md), end to end: a file put where a browser is told,
// read and built by the worker into a pack Blockly installs, and a server made from it; links
// pasted; and a pack changed like a deployment. Every fixture is a few kilobytes.
const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('packs people bring', () => {
  let h: Harness
  const cdn = new Cdn()
  const store = new S3ArchiveStore({
    endpoint: s3.endpoint ?? '',
    bucket: s3.bucket ?? '',
    region: 'auto',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  /** A mod published on the catalog, as Modrinth publishes one: its file, its sides, its sha1. */
  const published = (id: string, bytes: Uint8Array, environment: string) => {
    const file = cdn.file(id, bytes)
    const version: CatalogVersion = {
      versionId: `${id}-v1`,
      projectId: id,
      versionLabel: '1.0',
      channel: 'release',
      state: 'listed',
      environment: environment as CatalogVersion['environment'],
      loaders: ['fabric'],
      gameVersions: ['1.21.1'],
      publishedAt: new Date(Date.UTC(2026, 0, 1)),
      file,
      dependencies: [],
    }
    h.catalog.publish(
      {
        projectId: id,
        slug: id,
        name: id,
        summary: id,
        iconUrl: null,
        environments: [environment as CatalogVersion['environment']],
        downloads: 1,
      },
      [version],
    )
    h.catalog.fileSha1(file.sha512, sha1(bytes))
    return file
  }

  /** What a browser does: ask, put the bytes where it was told, say it is done; then wait for the read. */
  const upload = async (owner: UserActor, bytes: Uint8Array, fileName: string) => {
    const start = await h.app.packs.beginUpload(owner, { fileName, sizeBytes: bytes.length })
    const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
    expect(put.status).toBe(200)
    const { importId } = await h.app.packs.finishUpload(owner, start.ticket)
    for (let tries = 0; tries < 80; tries++) {
      const view = await h.app.packs.view(owner, importId)
      if (view.status !== 'reading') return view
      await Bun.sleep(250)
    }
    throw new Error('The pack was still being read after 20 seconds')
  }

  /** The pack Blockly built, as the image would download it. */
  const builtPack = async (importId: string) => {
    const [row] = await h.db.select().from(schema.packImports).where(eq(schema.packImports.id, importId))
    if (!row?.packSha512) throw new Error('No pack was built')
    const link = await store.presignGet(`artifacts/${row.packSha512}`, 60, 'browser')
    const files = unzipBytes(new Uint8Array(await (await fetch(link.url)).arrayBuffer()))
    return {
      names: Object.keys(files),
      index: JSON.parse(textOf(files['modrinth.index.json'] ?? utf8('{}'))),
    }
  }

  test('a server pack is read, built and made a server of, with the mods for players’ games left out', async () => {
    const lithium = fabricJar('lithium', { depends: { minecraft: '1.21.1' } })
    const sodium = fabricJar('sodium', { depends: { minecraft: '1.21.1' } })
    const custom = fabricJar('custom', { depends: { minecraft: '1.21.1' } })
    const lithiumFile = published('lithium', lithium, 'server_only')
    published('sodium', sodium, 'client_only')
    const zip = zipBytes({
      'MyPack-Server/mods/lithium.jar': lithium,
      'MyPack-Server/mods/sodium.jar': sodium,
      'MyPack-Server/mods/custom.jar': custom,
      'MyPack-Server/config/custom.toml': utf8('speed = 3\n'),
      'MyPack-Server/variables.txt': utf8(
        'MINECRAFT_VERSION=1.21.1\nMODLOADER=Fabric\nMODLOADER_VERSION=0.16.14\nJAVA_ARGS="-Xmx4G -Dfml.queryResult=confirm"\n',
      ),
      'MyPack-Server/start.sh': utf8('#!/bin/sh\njava @user_jvm_args.txt -jar server.jar\n'),
      'MyPack-Server/libraries/net/fabricmc/fabric-loader/0.16.14/loader.jar': utf8('x'),
      'MyPack-Server/world/level.dat': utf8('world'),
    })
    const owner = await h.user('Ari', 'plus')
    const view = await upload(owner, zip, 'MyPack-Server.zip')
    if (view.status !== 'ready') throw new Error(`Refused: ${view.status === 'refused' ? view.message : ''}`)
    expect(view.pack).toMatchObject({ name: 'MyPack', gameVersion: '1.21.1', loaderLabel: 'Fabric', mods: 2 })
    expect(view.pack.notes[0]).toBe('Cubepals left out one mod made for players’ games: sodium.')
    expect(view.pack.notes[1]).toContain('world of its own')

    // Built as one Modrinth pack: the catalog's mod by its download, the rest carried inside.
    const built = await builtPack(view.importId)
    expect(built.index.dependencies).toEqual({ minecraft: '1.21.1', 'fabric-loader': '0.16.14' })
    expect(built.index.files).toEqual([
      expect.objectContaining({
        path: 'mods/lithium.jar',
        downloads: [lithiumFile.url],
        hashes: { sha1: sha1(lithium), sha512: sha512(lithium) },
      }),
    ])
    expect(built.names.sort()).toEqual([
      'modrinth.index.json',
      'overrides/config/custom.toml',
      'overrides/mods/custom.jar',
    ])

    // A server made from it plays the built pack on what the pack runs on, with its start's properties.
    const server = await h.create(owner, { from: { kind: 'import', importId: view.importId } })
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    expect(revision).toMatchObject({
      gameVersion: '1.21.1',
      loader: 'fabric',
      loaderVersion: '0.16.14',
      mods: [],
    })
    expect(revision.modpack).toMatchObject({
      catalog: 'upload',
      name: 'MyPack',
      page: null,
      javaProperties: { 'fml.queryResult': 'confirm' },
    })
    await h.until(server.id, 'running')
    const [row] = await h.db
      .select({ from: schema.minecraftServers.createdFrom })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.id, server.id))
    expect(row?.from).toBe('upload')
  }, 60_000)

  test('a plain folder of mods, and a Packwiz pack of Modrinth mods, are built into servers too', async () => {
    const owner = await h.user('Eli', 'plus')
    // Nothing but mods and their configs: the loader and Minecraft come from the jars.
    const folder = zipBytes({
      'mods/alpha.jar': fabricJar('alpha', { depends: { minecraft: '1.21.1' } }),
      'mods/beta.jar': fabricJar('beta', { depends: { minecraft: '1.21.1' } }),
      'config/alpha.toml': utf8('on = true\n'),
    })
    const plain = await upload(owner, folder, 'Weekend Mods.zip')
    if (plain.status !== 'ready')
      throw new Error(`Refused: ${plain.status === 'refused' ? plain.message : ''}`)
    expect(plain.pack).toMatchObject({
      name: 'Weekend Mods',
      gameVersion: '1.21.1',
      loaderLabel: 'Fabric',
      mods: 2,
    })
    expect((await builtPack(plain.importId)).names.sort()).toEqual([
      'modrinth.index.json',
      'overrides/config/alpha.toml',
      'overrides/mods/alpha.jar',
      'overrides/mods/beta.jar',
    ])

    // Packwiz: its mods named by their Modrinth versions, each side checked against the catalog.
    const lith = published(
      'wizlith',
      fabricJar('wizlith', { depends: { minecraft: '1.21.1' } }),
      'server_only',
    )
    published('wizsod', fabricJar('wizsod', { depends: { minecraft: '1.21.1' } }), 'client_only')
    const metafile = (id: string) =>
      utf8(
        `name = "${id}"\nfilename = "${id}.jar"\nside = "both"\n[download]\nurl = "https://cdn.modrinth.com/data/${id}/${id}.jar"\nhash-format = "sha1"\nhash = "00"\n[update.modrinth]\nmod-id = "${id}"\nversion = "${id}-v1"\n`,
      )
    const wiz = (extra: Record<string, Uint8Array>) =>
      zipBytes({
        'pack.toml': utf8(
          'name = "Wiz"\nversion = "3.0"\npack-format = "packwiz:1.1.0"\n[index]\nfile = "index.toml"\nhash-format = "sha256"\nhash = "00"\n[versions]\nminecraft = "1.21.1"\nfabric = "0.16.14"\n',
        ),
        'index.toml': utf8(
          `hash-format = "sha256"\n${Object.keys({
            'mods/wizlith.pw.toml': 1,
            'mods/wizsod.pw.toml': 1,
            ...extra,
          })
            .map((file) => `[[files]]\nfile = "${file}"\nhash = "00"\nmetafile = true\n`)
            .join('')}[[files]]\nfile = "config/wiz.toml"\nhash = "00"\n`,
        ),
        'mods/wizlith.pw.toml': metafile('wizlith'),
        'mods/wizsod.pw.toml': metafile('wizsod'),
        'config/wiz.toml': utf8('wiz = 1\n'),
        ...extra,
      })
    const packwiz = await upload(owner, wiz({}), 'wiz.zip')
    if (packwiz.status !== 'ready')
      throw new Error(`Refused: ${packwiz.status === 'refused' ? packwiz.message : ''}`)
    expect(packwiz.pack).toMatchObject({
      name: 'Wiz',
      version: '3.0',
      gameVersion: '1.21.1',
      loaderLabel: 'Fabric',
    })
    expect(packwiz.pack.notes[0]).toBe('Cubepals left out one mod made for players’ games: wizsod.')
    const built = await builtPack(packwiz.importId)
    expect(built.index.files).toEqual([
      expect.objectContaining({ path: 'mods/wizlith.jar', downloads: [lith.url] }),
    ])
    expect(built.names).toContain('overrides/config/wiz.toml')

    // One of its mods from CurseForge: said in one sentence.
    const fromCurseForge = utf8(
      'name = "cf"\nfilename = "cf.jar"\nside = "both"\n[download]\nmode = "metadata:curseforge"\nhash-format = "sha1"\nhash = "00"\n[update.curseforge]\nproject-id = 1\nfile-id = 2\n',
    )
    expect(await upload(owner, wiz({ 'mods/cf.pw.toml': fromCurseForge }), 'wiz-cf.zip')).toMatchObject({
      status: 'refused',
      message: 'This pack gets some of its mods from CurseForge, which Cubepals can’t download from.',
    })
  }, 60_000)

  test('a pack naming an older loader than its mods accept runs on one they do, and says so', async () => {
    const zip = zipBytes({
      'Tidy-Server-2.1/mods/tidy.jar': fabricJar('tidy', {
        name: 'Tidy',
        depends: { minecraft: '1.21.1', fabricloader: '>=0.17.3' },
      }),
      'Tidy-Server-2.1/variables.txt': utf8(
        'MINECRAFT_VERSION=1.21.1\nMODLOADER=Fabric\nMODLOADER_VERSION=0.16.14\n',
      ),
    })
    const view = await upload(await h.user('Cy', 'plus'), zip, 'Tidy-Server-2.1.zip')
    if (view.status !== 'ready') throw new Error(`Refused: ${view.status === 'refused' ? view.message : ''}`)
    expect(view.pack).toMatchObject({ name: 'Tidy', version: '2.1' })
    expect(view.pack.notes).toContain(
      'Cubepals runs it on Fabric 0.19.5: Tidy needs a newer one than the pack names.',
    )
    expect((await builtPack(view.importId)).index.dependencies).toEqual({
      minecraft: '1.21.1',
      'fabric-loader': '0.19.5',
    })

    // One no build Blockly can run satisfies is refused before anything is made.
    const stuck = zipBytes({
      'mods/far.jar': fabricJar('far', {
        name: 'Far',
        depends: { minecraft: '1.21.1', fabricloader: '>=9' },
      }),
      'variables.txt': utf8('MINECRAFT_VERSION=1.21.1\nMODLOADER=Fabric\nMODLOADER_VERSION=0.16.14\n'),
    })
    expect(await upload(await h.user('Di', 'plus'), stuck, 'far.zip')).toMatchObject({
      status: 'refused',
      message: 'Far needs a version of Fabric Cubepals can’t run on Minecraft 1.21.1.',
    })
  }, 60_000)

  test('a CurseForge export, a zip that escapes its folder and a file with no pack are refused in one sentence', async () => {
    const owner = await h.user('Bo', 'plus')
    const export_ = zipBytes({
      'manifest.json': utf8(
        JSON.stringify({
          manifestType: 'minecraftModpack',
          manifestVersion: 1,
          name: 'All the Mods 9',
          minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
          files: [{ projectID: 1, fileID: 2, required: true }],
          overrides: 'overrides',
        }),
      ),
      'overrides/config/a.toml': utf8('a'),
    })
    const cf = await upload(owner, export_, 'atm9.zip')
    expect(cf).toMatchObject({ status: 'refused' })
    expect(cf.status === 'refused' && cf.message).toContain('download its server pack from Files')

    const slip = zipBytes({ '../../escape.jar': fabricJar('evil'), 'mods/a.jar': fabricJar('a') })
    const hostile = await upload(owner, slip, 'slip.zip')
    expect(hostile).toMatchObject({
      status: 'refused',
      message: 'This file can’t be opened safely, so Cubepals won’t use it.',
    })

    const nothing = await upload(owner, zipBytes({ 'README.md': utf8('hi') }), 'notes.zip')
    expect(nothing).toMatchObject({
      status: 'refused',
      message: 'This file doesn’t hold a modpack Cubepals can build a server from.',
    })
    const notZip = await upload(owner, utf8('not a zip at all'), 'broken.zip')
    expect(notZip).toMatchObject({
      status: 'refused',
      message: 'This file isn’t a zip or a Modrinth pack Cubepals can open.',
    })
  }, 60_000)

  test('a Prism instance says its loader, and its mods say the rest', async () => {
    const owner = await h.user('Cy', 'plus')
    const zip = zipBytes({
      'Friends/instance.cfg': utf8('InstanceType=OneSix\nname=Friends\n'),
      'Friends/mmc-pack.json': utf8(
        JSON.stringify({
          formatVersion: 1,
          components: [
            { uid: 'net.minecraft', version: '1.21.1' },
            { uid: 'net.fabricmc.fabric-loader', version: '0.16.10' },
          ],
        }),
      ),
      'Friends/.minecraft/mods/sodium.jar': fabricJar('sodium-again', {
        environment: 'client',
        depends: { minecraft: '1.21.1' },
      }),
      'Friends/.minecraft/mods/farm.jar': fabricJar('farm', { depends: { minecraft: '1.21.1' } }),
      'Friends/.minecraft/options.txt': utf8('fov:90'),
      'Friends/.minecraft/resourcepacks/pretty.zip': utf8('x'),
    })
    const view = await upload(owner, zip, 'Friends.zip')
    if (view.status !== 'ready') throw new Error(`Refused: ${view.status === 'refused' ? view.message : ''}`)
    expect(view.pack).toMatchObject({
      name: 'Friends',
      gameVersion: '1.21.1',
      loaderLabel: 'Fabric',
      mods: 1,
    })
    const built = await builtPack(view.importId)
    expect(built.index.dependencies).toEqual({ minecraft: '1.21.1', 'fabric-loader': '0.16.10' })
    expect(built.names.sort()).toEqual(['modrinth.index.json', 'overrides/mods/farm.jar'])
  }, 60_000)

  test('a Modrinth pack downloaded from Modrinth is recognised as the published pack it is', async () => {
    const pack = zipBytes({
      'modrinth.index.json': utf8(
        JSON.stringify({
          formatVersion: 1,
          game: 'minecraft',
          versionId: '2.0',
          name: 'Known Pack',
          files: [],
          dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
        }),
      ),
    })
    const file = cdn.file('known-pack-2', pack)
    h.catalog.publishModpack(
      {
        projectId: 'known-pack',
        slug: 'known-pack',
        name: 'Known Pack',
        summary: 'Known',
        iconUrl: null,
        environments: ['client_and_server'],
        downloads: 5,
        categories: [],
      },
      [
        {
          versionId: 'known-2',
          projectId: 'known-pack',
          versionLabel: '2.0',
          channel: 'release',
          state: 'listed',
          environment: 'client_and_server',
          loaders: ['fabric'],
          gameVersions: ['1.21.1'],
          publishedAt: new Date(Date.UTC(2026, 1, 1)),
          file,
          dependencies: [],
        },
      ],
    )
    const owner = await h.user('Dee', 'plus')
    const view = await upload(owner, pack, 'Known Pack 2.0.mrpack')
    expect(view.status).toBe('ready')
    const server = await h.create(owner, { from: { kind: 'import', importId: view.importId } })
    const revision = await loadRevision(h.db, server.desiredRevisionId)
    // Pinned as the catalog's pack, so it has its page, its links and its updates.
    expect(revision.modpack).toMatchObject({
      catalog: 'modrinth',
      projectId: 'known-pack',
      versionId: 'known-2',
    })
  }, 60_000)

  test('links: a Modrinth pack’s page is that pack, a CurseForge one says where its server pack is', async () => {
    const owner = await h.user('Eli', 'plus')
    const modrinth = await h.app.queries.packFromLink(
      owner,
      'https://catalog.test/modpack/known-pack/version/known-2',
    )
    expect(modrinth).toMatchObject({
      kind: 'pack',
      versionId: 'known-2',
      versionLabel: '2.0',
      hit: { name: 'Known Pack' },
    })
    // As copied from an address bar, without its https://, and with a space around it.
    expect(
      await h.app.queries.packFromLink(owner, '  catalog.test/modpack/known-pack/version/known-2 '),
    ).toMatchObject({ kind: 'pack', versionId: 'known-2' })
    const curseforge = await h.app.queries.packFromLink(
      owner,
      'https://www.curseforge.com/minecraft/modpacks/all-the-mods-10',
    )
    expect(curseforge).toEqual({
      kind: 'refused',
      message:
        'Cubepals can’t download from CurseForge. On All The Mods 10’s page, download its server pack from Files, then drop it here.',
      page: 'https://www.curseforge.com/minecraft/modpacks/all-the-mods-10/files',
    })
    const elsewhere = await h.app.queries.packFromLink(owner, 'https://example.test/pack.zip')
    expect(elsewhere).toMatchObject({ kind: 'refused', page: null })
  }, 30_000)
})

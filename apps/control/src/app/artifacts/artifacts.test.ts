// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { schema } from '@blockly/db'
import { and, asc, eq } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { diskName } from '../../minecraft/jars.ts'
import { Cdn, jar, sha512 } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'

/** Mods pinned as resolution hands them over; these tests are about what happens after. */
async function pin(h: Harness, owner: UserActor, id: string, mods: PinnedMod[]) {
  const basedOn = (await h.server(id)).desiredRevisionId
  await h.app.revisions.changeMods(owner, id, { basedOn, mods }, randomUUID())
}

// Jars at boot, end to end (§15.2): preflight, the runtime endpoint, the install check.
describe.skipIf(!hasDatabase)('artifacts', () => {
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

  const modded = async () => {
    const owner = await h.user('Steve', 'plus')
    const server = await h.create(owner, { loader: 'fabric' })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const withMods = async (owner: UserActor, id: string, mods: PinnedMod[]) => {
    const before = await h.server(id)
    await pin(h, owner, id, mods)
    await h.until(id, (s) => s.lifecycle.status !== 'updating' && s.version > before.version + 1, 20_000)
    return h.settled(id, 20_000)
  }
  const lastApply = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'apply').at(-1)
  const linksOf = async (id: string) =>
    ((await h.app.specs.desired(h.db, await h.server(id))).spec.env.MODS ?? '').split(',').filter(Boolean)

  test('a server installs its mods through the endpoint, under names unique to their bytes, and checks them', async () => {
    const { owner, id } = await modded()
    const lithium = cdn.publish('lithium')
    const downloads = cdn.downloads
    await withMods(owner, id, [lithium])
    const apply = await lastApply(id)
    expect(apply?.status).toBe('succeeded')
    expect(await h.minecraft.jars(id)).toEqual([diskName(lithium.artifact)])
    expect(sha512(await readFile(h.minecraft.path(id, `mods/${diskName(lithium.artifact)}`)))).toBe(
      lithium.artifact.sha512,
    )
    expect(cdn.downloads).toBe(downloads + 1)

    // A restart takes the jar from disk: the image asks the endpoint, and the CDN sees nothing.
    await h.app.servers.restart(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(cdn.downloads).toBe(downloads + 1)
  })

  test('the endpoint answers from the database, for this server’s own token and pins only', async () => {
    const { owner, id } = await modded()
    const sodium = cdn.publish('sodium')
    await withMods(owner, id, [sodium])
    const [link = ''] = await linksOf(id)
    const url = new URL(link)
    const [pinned] = await h.db
      .select({ createdAt: schema.serverRevisions.createdAt })
      .from(schema.serverRevisions)
      .where(and(eq(schema.serverRevisions.serverId, id), eq(schema.serverRevisions.reason, 'mods_changed')))
      .orderBy(asc(schema.serverRevisions.number))

    const head = await fetch(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('last-modified')).toBe(pinned?.createdAt.toUTCString() ?? '')
    expect(head.headers.get('content-length')).toBe(String(sodium.artifact.sizeBytes))
    expect(head.headers.get('content-disposition')).toContain(diskName(sodium.artifact))

    const get = await fetch(url, { redirect: 'manual' })
    expect(get.status).toBe(302)
    expect(get.headers.get('location')).toBe(
      sodium.artifact.ref.kind === 'remote' ? sodium.artifact.ref.url : '',
    )

    const other = await modded()
    const refused = async (patch: (u: URL) => void) => {
      const changed = new URL(url)
      patch(changed)
      return (await fetch(changed, { method: 'HEAD' })).status
    }
    // Another server's token, the right token for other bytes, a renamed file, garbage.
    expect(await refused((u) => u.searchParams.set('t', 'x'.repeat(32)))).toBe(403)
    expect(await refused((u) => (u.pathname = u.pathname.replace(id, other.id)))).toBe(403)
    expect(
      await refused((u) => (u.pathname = u.pathname.replace(sodium.artifact.sha512, 'a'.repeat(128)))),
    ).toBe(404)
    expect(await refused((u) => (u.pathname = u.pathname.replace(/[^/]+$/, 'renamed.jar')))).toBe(404)
    expect(await refused((u) => (u.pathname = u.pathname.replace(id, 'not-a-server')))).toBe(404)
  })

  test('a jar cut short stops a modded server loading; it is downloaded again and the server comes up', async () => {
    const { owner, id } = await modded()
    const ferrite = cdn.publish('ferrite')
    await withMods(owner, id, [ferrite])
    const file = h.minecraft.path(id, `mods/${diskName(ferrite.artifact)}`)
    // What an interrupted download leaves: the start of the file, with a fresh modification time.
    await writeFile(file, (await readFile(file)).subarray(0, 100))
    const downloads = cdn.downloads

    await h.app.servers.restart(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' || s.lifecycle.status === 'failed')
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(sha512(await readFile(file))).toBe(ferrite.artifact.sha512)
    expect(cdn.downloads).toBe(downloads + 1)
    // The link now reports when the jars were found wrong, rounded up to a whole second.
    const [runtime] = await h.db
      .select()
      .from(schema.serverRuntimes)
      .where(eq(schema.serverRuntimes.serverId, id))
    const refreshed = runtime?.artifactsRefreshedAt?.getTime() ?? 0
    const [link = ''] = await linksOf(id)
    expect((await fetch(link, { method: 'HEAD' })).headers.get('last-modified')).toBe(
      new Date(Math.ceil(refreshed / 1000) * 1000).toUTCString(),
    )
  })

  test('a jar changed where it is published fails the check twice, and the change goes back', async () => {
    const { owner, id } = await modded()
    const lithium = cdn.publish('krypton')
    await withMods(owner, id, [lithium])
    const before = (await h.server(id)).desiredRevisionId
    const tampered = cdn.publish('c2me')
    cdn.replace(tampered, jar('something else entirely'))
    await withMods(owner, id, [lithium, tampered])

    const apply = await lastApply(id)
    expect(apply?.status).toBe('failed')
    expect(apply?.error).toContain("c2me didn't install as chosen")
    const after = await h.server(id)
    expect(after.lifecycle.status).toBe('running')
    expect(after.desiredRevisionId).toBe(before)
    // The image removed the jar the configuration it went back to doesn't list.
    expect(await h.minecraft.jars(id)).toEqual([diskName(lithium.artifact)])
  }, 30_000)

  test('an upload this deployment cannot serve is refused before anything is touched', async () => {
    const { owner, id } = await modded()
    const before = await h.server(id)
    const bytes = jar('my-own-mod')
    const upload: PinnedMod = {
      ...cdn.publish('my-own-mod'),
      source: { catalog: 'upload', uploadId: randomUUID() },
      artifact: {
        ref: { kind: 'stored', key: `artifacts/${sha512(bytes)}` },
        sha512: sha512(bytes),
        sizeBytes: bytes.length,
        fileName: 'my-own-mod.jar',
      },
    }
    await withMods(owner, id, [upload])
    const apply = await lastApply(id)
    expect(apply?.status).toBe('failed')
    expect(apply?.error).toBe(
      'Nothing changed: my-own-mod is an upload, and this deployment keeps no uploads.',
    )
    expect(apply?.step).toBeNull()
    const after = await h.server(id)
    expect(after.lifecycle.status).toBe('running')
    expect(after.desiredRevisionId).toBe(before.desiredRevisionId)
    // No pre-apply snapshot either: the runtime was never asked for anything.
    expect(await h.db.select().from(schema.backups).where(eq(schema.backups.serverId, id))).toHaveLength(0)
  })

  test('a mod taken down where it was published runs only if the owner says so, and never boots otherwise', async () => {
    const withheld = (projectId: string) =>
      h.db.insert(schema.catalogProjects).values({
        catalog: 'modrinth',
        projectId,
        state: 'withheld',
        fetchedAt: new Date(),
        stateChangedAt: new Date(),
      })
    const { owner, id } = await modded()
    const phosphor = cdn.publish('phosphor')
    await withheld('phosphor-project')
    await expect(pin(h, owner, id, [phosphor])).rejects.toThrow(
      'phosphor was taken down where it was published',
    )
    expect(await lastApply(id)).toBeUndefined()

    // Run anyway: the revision records the choice, and its boot honours it.
    const before = await h.server(id)
    await h.app.revisions.changeMods(
      owner,
      id,
      { basedOn: before.desiredRevisionId, mods: [phosphor] },
      randomUUID(),
      { acknowledgeRevoked: true },
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1)
    await h.settled(id)
    expect((await lastApply(id))?.status).toBe('succeeded')
    expect((await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).acknowledgedRevoked).toEqual([
      phosphor.artifact.sha512,
    ])

    // Taken down after it was pinned, and never acknowledged: its first boot is refused.
    const other = await modded()
    const lights = cdn.publish('dynamic-lights')
    await h.app.servers.stop(other.owner, other.id, randomUUID())
    await h.until(other.id, 'stopped')
    await pin(h, other.owner, other.id, [lights])
    await withheld('dynamic-lights-project')
    await h.app.servers.start(other.owner, other.id, randomUUID())
    const failed = await h.until(other.id, 'failed')
    expect(failed.lifecycle.failure?.message).toBe('dynamic-lights was taken down where it was published.')
  })
})

// Where the deployment keeps jars itself: uploads, and mirrored catalog files (§15.2).
const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}
describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('artifacts kept by the deployment', () => {
  let h: Harness
  const cdn = new Cdn()
  const store = new S3ArchiveStore({
    endpoint: s3.endpoint ?? '',
    bucket: s3.bucket ?? '',
    region: 'auto',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })
  const written: string[] = []

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness({ capabilities: { archives: store, billing: null }, mirrorCatalogArtifacts: true })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
    for (const key of written) await store.delete(key)
  })

  test('an upload is fetched from the store, and a catalog jar from the copy the deployment keeps', async () => {
    const owner = await h.user('Steve', 'plus')
    const created = await h.create(owner, { loader: 'fabric' })
    const id = created.id
    await h.until(id, 'running')
    await h.settled(id)

    const bytes = jar(`uploaded ${randomUUID()}`)
    const key = `uploads/${sha512(bytes)}.jar`
    const put = await store.presignPut(key, 60, 'browser')
    expect((await fetch(put.url, { method: 'PUT', body: bytes, headers: put.headers })).ok).toBe(true)
    written.push(key)
    await h.db.insert(schema.storedArtifacts).values({
      sha512: sha512(bytes),
      key,
      sizeBytes: bytes.length,
      source: 'upload',
      verifiedAt: new Date(),
    })
    const upload: PinnedMod = {
      ...cdn.publish('placeholder'),
      name: 'my-own-mod',
      source: { catalog: 'upload', uploadId: randomUUID() },
      artifact: {
        ref: { kind: 'stored', key },
        sha512: sha512(bytes),
        sizeBytes: bytes.length,
        fileName: 'mine.jar',
      },
    }
    const catalog = cdn.publish(`mirrored-${randomUUID().slice(0, 8)}`)
    written.push(`artifacts/${catalog.artifact.sha512}`)

    const before = await h.server(id)
    await pin(h, owner, id, [upload, catalog])
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
    expect((await h.operations(id)).filter((op) => op.kind === 'apply').at(-1)?.status).toBe('succeeded')
    expect(await h.minecraft.jars(id)).toEqual([diskName(catalog.artifact), diskName(upload.artifact)].sort())

    // The mirror copied the catalog file once; the server's download came from the store.
    expect(cdn.downloads).toBe(1)
    const [mirrored] = await h.db
      .select()
      .from(schema.storedArtifacts)
      .where(eq(schema.storedArtifacts.sha512, catalog.artifact.sha512))
    expect(mirrored?.source).toBe('mirror')
    const links = ((await h.app.specs.desired(h.db, await h.server(id))).spec.env.MODS ?? '').split(',')
    for (const link of links) {
      const location = (await fetch(link, { redirect: 'manual' })).headers.get('location') ?? ''
      expect(location.startsWith(s3.endpoint ?? '-')).toBe(true)
    }
  }, 30_000)
})

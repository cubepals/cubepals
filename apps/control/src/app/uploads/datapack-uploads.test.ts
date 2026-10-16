// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An owner's own datapack end to end (§15.2): uploaded through the same presigned PUT as a jar
 * into a real S3 store, opened as hostile input, kept under its hash, pinned and put into the
 * world like a Modrinth datapack, and judged like any upload by the directory and by copying.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { datapackName } from '../../minecraft/datapacks.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { unzipBytes, utf8, zipBytes } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'
import { uploadNote } from '../mods/queries.ts'
import type { ModChange } from '../mods/service.ts'
import { loadRevision } from '../servers/persistence.ts'

const sha512 = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('hex')

const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

/** A minigame as its author zips it: what it is, its picture and its functions. */
const minigame = (tag: string, meta: object = { pack: { pack_format: 121, description: `Tag ${tag}` } }) => ({
  'pack.mcmeta': utf8(JSON.stringify(meta)),
  'pack.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  'data/tag/function/start.mcfunction': utf8(`say ${tag} begins`),
  'data/minecraft/tags/function/load.json': utf8('{"values":["tag:start"]}'),
})

const skip = !hasDatabase || !s3.endpoint || !s3.bucket

let h: Harness
const store = new S3ArchiveStore({
  endpoint: s3.endpoint ?? '',
  bucket: s3.bucket ?? '',
  region: 'auto',
  accessKeyId: s3.accessKeyId,
  secretAccessKey: s3.secretAccessKey,
})
const written: string[] = []

beforeAll(async () => {
  if (!skip) h = await startHarness({ capabilities: { archives: store, billing: null } })
}, 30_000)

afterAll(async () => {
  if (skip) return
  await h.close()
  for (const key of written) await store.delete(key)
})

const server = async (plan = 'plus') => {
  const owner = await h.user('Steve', plan)
  const created = await h.create(owner, { loader: 'vanilla' })
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return { owner, id: created.id }
}

/** What a browser does: ask, put the bytes where it was told, then say it is done. */
const send = async (owner: UserActor, id: string, bytes: Uint8Array, fileName: string) => {
  const start = await h.app.mods.beginUpload(owner, id, {
    fileName,
    sizeBytes: bytes.length,
    sha512: sha512(bytes),
  })
  if (start.kind === 'known') return start.upload
  const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
  expect(put.status).toBe(200)
  const upload = await h.app.mods.finishUpload(owner, id, start.ticket)
  written.push(upload.key)
  return upload
}
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }),
  )
const change = async (owner: UserActor, id: string, requested: ModChange) => {
  const plan = await h.app.mods.plan(owner, id, requested)
  if (plan.kind !== 'ok') throw new Error(`Conflicts: ${JSON.stringify(plan.conflicts)}`)
  const before = await h.server(id)
  await h.app.mods.apply(
    owner,
    id,
    requested,
    plan.mods.map((m) => m.artifact.sha512),
    randomUUID(),
  )
  await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
  await h.settled(id, 20_000)
  return plan
}
const datapacksEnv = async (id: string) =>
  (await h.app.specs.desired(h.db, await h.server(id))).spec.env.BLOCKLY_DATAPACKS

describe.skipIf(skip)('datapack uploads: an owner’s datapack', () => {
  test('an uploaded datapack is kept under its hash, pinned, put into the world and taken out', async () => {
    const { owner, id } = await server()
    const tag = randomUUID().slice(0, 6)
    const bytes = zipBytes(minigame(tag))
    const upload = await send(owner, id, bytes, 'My Minigame.zip')
    expect(upload).toMatchObject({
      sha512: sha512(bytes),
      fileName: 'My-Minigame.zip',
      key: `artifacts/${sha512(bytes)}`,
      sizeBytes: bytes.length,
    })
    expect(upload.metadata).toMatchObject({ format: 'pack.mcmeta', name: `Tag ${tag}`, leftOut: false })
    expect(uploadNote(upload)).toBeNull()
    const [kept] = await h.db
      .select()
      .from(schema.storedArtifacts)
      .where(eq(schema.storedArtifacts.sha512, sha512(bytes)))
    expect(kept?.source).toBe('upload')
    expect(await h.db.select().from(schema.pendingUploads)).toEqual([])

    // The same bytes again are the same upload, with nothing to send.
    const again = await h.app.mods.beginUpload(owner, id, {
      fileName: 'renamed.zip',
      sizeBytes: bytes.length,
      sha512: sha512(bytes),
    })
    expect(again).toMatchObject({ kind: 'known', upload: { id: upload.id } })

    // The same diff as a Modrinth datapack: a vanilla world stays vanilla for it.
    const before = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    const plan = await change(owner, id, { addUploads: [upload.id] })
    expect(plan.kind === 'ok' && plan.loader).toBe('vanilla')
    expect(h.app.modQueries.planView(plan)).toMatchObject({
      added: [
        { name: `Tag ${tag}`, versionLabel: sha512(bytes).slice(0, 12), source: 'upload', datapack: true },
      ],
    })
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(revision.loader).toBe('vanilla')
    const [pinned] = revision.mods
    if (pinned === undefined) throw new Error('The datapack was not pinned')
    expect(pinned).toMatchObject({
      source: { catalog: 'upload', uploadId: upload.id },
      environment: 'server',
    })
    // Fetched through the same endpoint as every jar, and checked against the same hash.
    const listed = await datapacksEnv(id)
    expect(listed).toStartWith(`${sha512(bytes)} ${datapackName(pinned.artifact)} `)
    expect(listed).toContain('/runtime/v1/artifacts/')

    const uploads = await h.app.modQueries.uploads(owner, id)
    expect(uploads.find((u) => u.id === upload.id)).toMatchObject({
      kind: 'datapack',
      version: sha512(bytes).slice(0, 12),
      inUse: true,
      fits: true,
    })
    expect(await refusal(h.app.mods.deleteUpload(owner, id, upload.id))).toMatchObject({
      code: 'invalid_choice',
    })

    // Rolling back takes it out of the world; removing it is a normal revision.
    await h.app.revisions.rollback(owner, id, before.id, randomUUID())
    await h.settled(id, 20_000)
    expect(await datapacksEnv(id)).toBeUndefined()
    await change(owner, id, { addUploads: [upload.id] })
    await change(owner, id, { remove: [`upload:${upload.id}`] })
    expect(await datapacksEnv(id)).toBeUndefined()
    // Earlier revisions still pin it, and a rollback would want it back: it stays.
    expect(await refusal(h.app.mods.deleteUpload(owner, id, upload.id))).toMatchObject({
      code: 'invalid_choice',
    })
  }, 90_000)
})

describe.skipIf(skip)('datapack uploads: one wrapped in a folder', () => {
  test('a datapack in a folder, with resource-pack files, is kept as the datapack alone, and says so', async () => {
    const { owner, id } = await server()
    const tag = randomUUID().slice(0, 6)
    const files = {
      ...minigame(tag),
      'assets/tag/textures/item/wand.png': new Uint8Array([1, 2, 3]),
    }
    const wrapped = zipBytes(
      Object.fromEntries([
        ...Object.entries(files).map(([name, data]) => [`My Minigame/${name}`, data]),
        ['__MACOSX/My Minigame/._pack.mcmeta', new Uint8Array([0])],
      ]),
    )
    const upload = await send(owner, id, wrapped, 'my-minigame.zip')
    expect(upload.sha512).not.toBe(sha512(wrapped))
    expect(uploadNote(upload)).toBe('Resource-pack files are left out.')
    const stored = await fetch((await store.presignGet(upload.key, 60, 'browser')).url)
    const kept = unzipBytes(new Uint8Array(await stored.arrayBuffer()))
    expect(Object.keys(kept).sort()).toEqual([
      'data/minecraft/tags/function/load.json',
      'data/tag/function/start.mcfunction',
      'pack.mcmeta',
      'pack.png',
    ])
    expect(sha512(kept['pack.mcmeta'] ?? new Uint8Array())).toBe(sha512(files['pack.mcmeta']))
    expect((await h.app.modQueries.uploads(owner, id))[0]?.note).toBe('Resource-pack files are left out.')
  }, 40_000)
})

describe.skipIf(skip)('datapack uploads: refusals', () => {
  test('what isn’t a datapack, or isn’t safe to open, is refused in one sentence', async () => {
    const { owner, id } = await server()
    const attempt = async (files: Record<string, Uint8Array>) => {
      const bytes = zipBytes(files)
      const start = await h.app.mods.beginUpload(owner, id, {
        fileName: 'game.zip',
        sizeBytes: bytes.length,
        sha512: sha512(bytes),
      })
      if (start.kind !== 'upload') throw new Error('Expected a link')
      await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
      return refusal(h.app.mods.finishUpload(owner, id, start.ticket))
    }
    const pack = minigame('x')
    expect(await attempt({ 'data/x/function/a.mcfunction': utf8('say hi') })).toEqual({
      code: 'invalid_upload',
      message: 'This isn’t a datapack: it has no pack.mcmeta at its top.',
    })
    expect(await attempt({ ...pack, 'pack.mcmeta': utf8('{"pack":{"description":"x"}}') })).toEqual({
      code: 'invalid_upload',
      message: 'Its pack.mcmeta doesn’t say which Minecraft it was made for (pack_format).',
    })
    expect(await attempt({ ...pack, 'data/x/Evil.class': new Uint8Array([0xca, 0xfe]) })).toEqual({
      code: 'invalid_upload',
      message: 'It holds Evil.class, which is code or another archive. A datapack holds neither.',
    })
    expect(await attempt({ ...pack, 'data/x/inner.zip': zipBytes({ a: utf8('a') }) })).toMatchObject({
      message: 'It holds inner.zip, which is code or another archive. A datapack holds neither.',
    })
    expect(await attempt({ ...pack, 'README.txt': utf8('read me') })).toEqual({
      code: 'invalid_upload',
      message:
        'It holds README.txt, which isn’t part of a datapack. A datapack holds pack.mcmeta, pack.png and a data folder.',
    })
    expect(await attempt({ ...pack, '../escape.mcfunction': utf8('say out') })).toEqual({
      code: 'invalid_upload',
      message: 'This zip names a file outside itself, so Cubepals won’t open it.',
    })
    expect(await attempt({ ...pack, 'data/x/structure/huge.nbt': new Uint8Array(32 * 1024 * 1024) })).toEqual(
      {
        code: 'invalid_upload',
        message: 'This zip unpacks to far more than it holds, so Cubepals won’t open it.',
      },
    )
    // Made for 1.21 and 1.21.1; the server runs today's release.
    const { gameVersion } = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(await attempt(minigame('old', { pack: { pack_format: 48, description: 'Old' } }))).toEqual({
      code: 'invalid_upload',
      message: `It was made for Minecraft 1.21–1.21.1, and this server runs ${gameVersion}.`,
    })
    // Nothing refused was kept.
    expect(await h.app.modQueries.uploads(owner, id)).toEqual([])
  }, 60_000)
  test('a plan without datapacks can’t upload one', async () => {
    const { owner, id } = await server('free')
    const bytes = zipBytes(minigame('free'))
    expect(
      await refusal(
        h.app.mods.beginUpload(owner, id, {
          fileName: 'game.zip',
          sizeBytes: bytes.length,
          sha512: sha512(bytes),
        }),
      ),
    ).toEqual({ code: 'not_entitled', message: 'Your plan does not include datapacks.' })
    expect((await h.app.modQueries.list(owner, id)).datapackUploads).toMatchObject({
      available: false,
      code: 'not_entitled',
    })
  })
})

describe.skipIf(skip)('datapack uploads: trust', () => {
  test('a server running an uploaded datapack isn’t listed or copied', async () => {
    const { owner, id } = await server()
    const tag = randomUUID().slice(0, 6)
    const upload = await send(owner, id, zipBytes(minigame(tag)), 'game.zip')
    await change(owner, id, { addUploads: [upload.id] })
    await h.app.servers.saveIdentity(owner, id, { name: 'Minigame Night' })
    await h.app.listings.setPublic(owner, id, true)
    const deadline = Date.now() + 10_000
    let view = await h.app.listingQueries.own(owner, id)
    while (!view?.reasons.some((r) => r.code === 'untrusted_mods') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      view = await h.app.listingQueries.own(owner, id)
    }
    expect(view).toMatchObject({
      eligible: false,
      reasons: [{ code: 'untrusted_mods', detail: `Tag ${tag}: uploaded_datapack` }],
    })
    expect((await h.app.sharingQueries.share(owner, id)).copying).toEqual({
      on: false,
      locked: true,
      why: 'It runs a datapack you uploaded, which is yours alone.',
    })
  }, 60_000)
})

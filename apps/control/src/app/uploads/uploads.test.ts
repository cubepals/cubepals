import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { diskName } from '../../minecraft/jars.ts'
import { Cdn } from '../../testing/cdn.ts'
import { downloaded } from '../../testing/downloads.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { fabricJar, levelDat, zipOf } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import { loadRevision } from '../servers/persistence.ts'
import { listWorlds } from '../worlds/persistence.ts'

const run = promisify(execFile)
const sha512 = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('hex')

// Uploads end to end (§15.2, §15.4): jars and world downloads through presigned PUTs into a
// real S3 store, checked, kept, used, and collected when nothing uses them; catalog jars
// mirrored through their queue.
const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}

describe.skipIf(!hasDatabase || !s3.endpoint || !s3.bucket)('uploads', () => {
  let h: Harness
  let scratch: string
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
    scratch = await mkdtemp(join(tmpdir(), 'blockly-uploads-'))
    h = await startHarness({ capabilities: { archives: store, billing: null }, mirrorCatalogArtifacts: true })
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
    await rm(scratch, { recursive: true, force: true })
    for (const key of written) await store.delete(key)
  })

  const server = async (plan = 'plus', loader: 'fabric' | 'vanilla' = 'fabric') => {
    const owner = await h.user('Steve', plan)
    const created = await h.create(owner, { loader })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id }
  }

  /** What a browser does: ask, put the bytes where it was told, then say it is done. */
  const uploadJar = async (owner: UserActor, id: string, bytes: Uint8Array, fileName = 'my-mod.jar') => {
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

  describe('mods and plugins', () => {
    test('an uploaded jar is checked, kept under its hash, and installed like any mod', async () => {
      const { owner, id } = await server()
      const bytes = fabricJar(`own-${randomUUID().slice(0, 6)}`)
      const upload = await uploadJar(owner, id, bytes, 'My Own Mod (v1).jar')
      expect(upload).toMatchObject({
        sha512: sha512(bytes),
        fileName: 'My-Own-Mod-v1-.jar',
        key: `artifacts/${sha512(bytes)}`,
        sizeBytes: bytes.length,
      })
      expect(upload.metadata).toMatchObject({ loaders: ['fabric'], environment: 'both', version: '1.0.0' })
      const [kept] = await h.db
        .select()
        .from(schema.storedArtifacts)
        .where(eq(schema.storedArtifacts.sha512, sha512(bytes)))
      expect(kept?.source).toBe('upload')
      // Only the stored copy is left: the staging object and its record are gone.
      expect(await h.db.select().from(schema.pendingUploads)).toEqual([])

      // The same bytes again are the same upload, with nothing to send.
      const again = await h.app.mods.beginUpload(owner, id, {
        fileName: 'renamed.jar',
        sizeBytes: bytes.length,
        sha512: sha512(bytes),
      })
      expect(again).toMatchObject({ kind: 'known', upload: { id: upload.id } })

      const plan = await h.app.mods.plan(owner, id, { addUploads: [upload.id] })
      expect(plan.kind === 'ok' && plan.added.map((m) => [m.name, m.source])).toEqual([
        [upload.metadata.name, { catalog: 'upload', uploadId: upload.id }],
      ])
      if (plan.kind !== 'ok') throw new Error('No plan')
      const before = await h.server(id)
      await h.app.mods.apply(
        owner,
        id,
        { addUploads: [upload.id] },
        plan.mods.map((m) => m.artifact.sha512),
        randomUUID(),
      )
      await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
      await h.settled(id, 20_000)
      const [installed] = (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).mods
      if (installed === undefined) throw new Error('The upload was not pinned')
      expect(installed.source).toEqual({ catalog: 'upload', uploadId: upload.id })
      expect(await h.minecraft.jars(id)).toEqual([diskName(installed.artifact)])

      const uploads = await h.app.modQueries.uploads(owner, id)
      expect(uploads.find((u) => u.id === upload.id)).toMatchObject({ inUse: true, fits: true })
      expect(await refusal(h.app.mods.deleteUpload(owner, id, upload.id))).toMatchObject({
        code: 'invalid_choice',
      })
    }, 40_000)

    test('what a server can’t run, or what isn’t what was sent, is refused', async () => {
      const { owner, id } = await server()
      const attempt = async (bytes: Uint8Array, declared = sha512(bytes), fileName = 'thing.jar') => {
        const start = await h.app.mods.beginUpload(owner, id, {
          fileName,
          sizeBytes: bytes.length,
          sha512: declared,
        })
        if (start.kind !== 'upload') throw new Error('Expected a link')
        await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
        return refusal(h.app.mods.finishUpload(owner, id, start.ticket))
      }
      const clientOnly = fabricJar('shaders', { environment: 'client' })
      const notAMod = zipOf({ 'README.txt': 'hello' })
      const cut = fabricJar('cut').subarray(0, 60)
      expect(await attempt(clientOnly)).toEqual({
        code: 'invalid_upload',
        message: 'Mod shaders only runs in players’ games, not on a server.',
      })
      expect(await attempt(notAMod)).toMatchObject({
        code: 'invalid_upload',
        message: expect.stringContaining('isn’t a mod or plugin'),
      })
      expect(await attempt(cut)).toEqual({ code: 'invalid_upload', message: 'This file isn’t a whole jar.' })
      expect(await attempt(fabricJar('swapped'), sha512(fabricJar('other')))).toEqual({
        code: 'invalid_upload',
        message: 'The file changed on its way here. Upload it again.',
      })
      expect(
        await refusal(
          h.app.mods.beginUpload(owner, id, {
            fileName: 'world.zip',
            sizeBytes: 10,
            sha512: 'a'.repeat(128),
          }),
        ),
      ).toMatchObject({
        code: 'invalid_upload',
      })

      // A plugin is a fine upload, and doesn't fit a Fabric server.
      const plugin = zipOf({ 'plugin.yml': 'name: Guard\nversion: 2.0\nmain: x.Guard\napi-version: 1.21\n' })
      const upload = await uploadJar(owner, id, plugin, 'guard.jar')
      expect(await h.app.mods.plan(owner, id, { addUploads: [upload.id] })).toEqual({
        kind: 'conflicts',
        conflicts: [{ kind: 'upload_does_not_fit', mod: 'Guard' }],
      })
      expect((await h.app.modQueries.uploads(owner, id)).find((u) => u.id === upload.id)).toMatchObject({
        fits: false,
        inUse: false,
      })
    }, 40_000)

    test('a jar the catalog publishes comes in as that mod: with what it needs, and held to where it runs', async () => {
      const { owner, id } = await server()
      const tag = randomUUID().slice(0, 6)
      const release = (
        projectId: string,
        bytes: Uint8Array,
        environment: CatalogVersion['environment'],
        needs: string[] = [],
      ) => {
        const file = cdn.file(`${projectId}-${tag}`, bytes)
        written.push(`artifacts/${file.sha512}`)
        const version: CatalogVersion = {
          versionId: `${projectId}-${tag}-1`,
          projectId: `${projectId}-${tag}`,
          versionLabel: '1',
          channel: 'release',
          state: 'listed',
          environment,
          loaders: ['fabric'],
          gameVersions: ['26.3'],
          publishedAt: new Date(),
          file,
          dependencies: needs.map((need) => ({
            projectId: `${need}-${tag}`,
            versionId: null,
            kind: 'required' as const,
          })),
        }
        h.catalog.publish(
          {
            projectId: version.projectId,
            slug: version.projectId,
            name: projectId,
            summary: '',
            iconUrl: null,
            environments: [environment],
            downloads: 1,
          },
          [version],
        )
        return version
      }
      // The jar says nothing of its dependencies Blockly could fetch; the catalog does.
      const waypointBytes = fabricJar(`waypoints${tag}`)
      const waypoints = release('waypoints', waypointBytes, 'client_and_server', ['balm'])
      const balm = release('balm', fabricJar(`balm${tag}`), 'client_and_server')
      const upload = await uploadJar(owner, id, waypointBytes, 'waypoints.jar')
      const plan = await h.app.mods.plan(owner, id, { addUploads: [upload.id] })
      if (plan.kind !== 'ok') throw new Error(`No plan: ${JSON.stringify(plan)}`)
      expect(
        plan.added.map((m) => m.source).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ).toEqual([
        { catalog: h.catalog.id, projectId: balm.projectId, versionId: balm.versionId },
        { catalog: h.catalog.id, projectId: waypoints.projectId, versionId: waypoints.versionId },
      ])

      // A jar that calls itself fine for servers, which the catalog knows only runs in players' games.
      const shaderBytes = fabricJar(`glow${tag}`)
      release('glow', shaderBytes, 'client_only')
      const start = await h.app.mods.beginUpload(owner, id, {
        fileName: 'glow.jar',
        sizeBytes: shaderBytes.length,
        sha512: sha512(shaderBytes),
      })
      if (start.kind !== 'upload') throw new Error('Expected a link')
      await fetch(start.url, { method: 'PUT', body: shaderBytes, headers: start.headers })
      expect(await refusal(h.app.mods.finishUpload(owner, id, start.ticket))).toEqual({
        code: 'invalid_upload',
        message: `Mod glow${tag} only runs in players’ games, not on a server.`,
      })
    }, 40_000)

    test('uploading needs a plan that includes it', async () => {
      // The free plan runs Vanilla and Paper, and uploads nothing of its own.
      const { owner, id } = await server('free', 'vanilla')
      const bytes = fabricJar('free-mod')
      expect(
        await refusal(
          h.app.mods.beginUpload(owner, id, {
            fileName: 'm.jar',
            sizeBytes: bytes.length,
            sha512: sha512(bytes),
          }),
        ),
      ).toMatchObject({ code: 'not_entitled' })
    })
  })

  describe('worlds', () => {
    /** A download as someone brings one back: a server's storage, packed. */
    const tarball = async (files: Record<string, string | Uint8Array>) => {
      const dir = join(scratch, randomUUID())
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, 'volume', path, '..'), { recursive: true })
        await writeFile(join(dir, 'volume', path), content)
      }
      await run('tar', ['-czf', join(dir, 'world.tar.gz'), '-C', join(dir, 'volume'), '.'])
      return new Uint8Array(await readFile(join(dir, 'world.tar.gz')))
    }
    const uploadWorld = async (owner: UserActor, id: string, bytes: Uint8Array, name?: string) => {
      const start = await h.app.backups.beginWorldUpload(owner, id, {
        fileName: 'world.tar.gz',
        sizeBytes: bytes.length,
      })
      const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
      expect(put.status).toBe(200)
      return h.app.backups.finishWorldUpload(owner, id, start.ticket, name)
    }
    const restore = async (owner: UserActor, id: string, backupId: string) => {
      await h.app.backups.restoreBackup(owner, id, backupId, randomUUID(), { withConfiguration: false })
      await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
      await h.settled(id, 20_000)
    }

    test('a download from one server comes back on another, as a backup to restore', async () => {
      const a = await server()
      await writeFile(h.minecraft.path(a.id, 'world/level.dat'), levelDat('26.3'))
      await writeFile(h.minecraft.path(a.id, 'world/built.txt'), 'the castle on A')
      await h.app.backups.createBackup(a.owner, a.id, randomUUID())
      await h.settled(a.id)
      const [snapshot] = (await listBackups(h.db, a.id)).filter((b) => b.trigger === 'manual')
      await h.app.backups.archiveBackup(a.owner, a.id, snapshot?.id ?? '', randomUUID())
      await h.settled(a.id)
      const [archive] = (await listBackups(h.db, a.id)).filter((b) => b.tier === 'archive')
      if (archive?.archiveKey) written.push(archive.archiveKey)
      const download = await downloaded(h.app, a.owner, a.id, archive?.id ?? '')

      // A world upload needs no plan of its own: a free, vanilla server takes it.
      const b = await server('free', 'vanilla')
      const uploaded = await uploadWorld(b.owner, b.id, download)
      if (uploaded.archiveKey) written.push(uploaded.archiveKey)
      const bWorld = (await listWorlds(h.db, b.id)).find((w) => w.levelName === 'world')
      expect(uploaded).toMatchObject({
        tier: 'archive',
        trigger: 'uploaded',
        status: 'ready',
        worldId: bWorld?.id,
        sizeBytes: download.length,
        worldFacts: { gameVersion: '26.3', levelType: 'minecraft:normal', hardcore: false, seed: null },
      })
      // Kept at least a week, though the free plan keeps no archives of its own.
      expect(
        Math.round(((uploaded.expiresAt?.getTime() ?? 0) - uploaded.createdAt.getTime()) / 86_400_000),
      ).toBe(7)
      expect(
        await h.db.select().from(schema.pendingUploads).where(eq(schema.pendingUploads.serverId, b.id)),
      ).toEqual([])

      await restore(b.owner, b.id, uploaded.id)
      expect((await h.server(b.id)).lifecycle.status).toBe('running')
      expect(await readFile(h.minecraft.path(b.id, 'world/built.txt'), 'utf8')).toBe('the castle on A')
    }, 60_000)

    test('a world made with mods comes back where mods run, and is refused, whole, where they don’t', async () => {
      const download = await tarball({
        'server.properties': 'level-name=world\n',
        'world/level.dat': levelDat('26.3'),
        'world/built.txt': 'a modded base',
        'mods/create.jar': fabricJar('create'),
      })
      // Opened on plain Minecraft it would lose every modded block: Free says so and keeps nothing.
      const free = await server('free', 'vanilla')
      expect(await refusal(uploadWorld(free.owner, free.id, download))).toMatchObject({
        code: 'not_entitled',
        message: 'Worlds made with mods come with Plus.',
      })
      const kept = (await listBackups(h.db, free.id)).filter((b) => b.trigger === 'uploaded')
      expect(kept).toEqual([])
      // On Plus it is a backup like any other.
      const plus = await server()
      const uploaded = await uploadWorld(plus.owner, plus.id, download)
      if (uploaded.archiveKey) written.push(uploaded.archiveKey)
      expect(uploaded).toMatchObject({ trigger: 'uploaded', status: 'ready' })
    }, 60_000)

    test('a world the server never had waits in the backup, and is itself once restored', async () => {
      const { owner, id } = await server()
      const download = await tarball({
        'server.properties':
          'level-name=survival\nlevel-type=minecraft\\:flat\nlevel-seed=42\nhardcore=true\n',
        'survival/level.dat': levelDat('26.1.2'),
        'survival/built.txt': 'a flat hardcore world',
      })
      const uploaded = await uploadWorld(owner, id, download, 'Brought back')
      if (uploaded.archiveKey) written.push(uploaded.archiveKey)
      const hidden = (await listWorlds(h.db, id)).find((w) => w.id === uploaded.worldId)
      expect(hidden).toMatchObject({
        levelName: 'survival',
        name: 'Brought back',
        levelType: 'minecraft:flat',
        hardcore: true,
      })
      expect(hidden?.deletedAt).not.toBeNull()
      expect((await h.app.worldQueries.list(owner, id)).map((w) => w.name)).not.toContain('Brought back')

      await restore(owner, id, uploaded.id)
      const restored = await h.server(id)
      expect(restored.lifecycle.status).toBe('running')
      expect(restored.activeWorldId).toBe(uploaded.worldId)
      expect(await readFile(h.minecraft.path(id, 'survival/built.txt'), 'utf8')).toBe('a flat hardcore world')
      const listed = (await h.app.worldQueries.list(owner, id)).find((w) => w.id === uploaded.worldId)
      expect(listed).toMatchObject({
        name: 'Brought back',
        active: true,
        seed: '42',
        hardcore: true,
        generatedOnVersion: '26.1.2',
      })
    }, 60_000)

    test('a world download is sized against the biggest disk the plan may have', async () => {
      // Free's disk never grows, so a download that wouldn't fit is refused before it's sent.
      const small = await server('free', 'vanilla')
      expect(
        await refusal(
          h.app.backups.beginWorldUpload(small.owner, small.id, {
            fileName: 'world.tar.gz',
            sizeBytes: 2 * 1024 ** 3,
          }),
        ),
      ).toEqual({
        code: 'invalid_upload',
        message: 'This server has room for a world download of up to 1.8 GB.',
      })
      // Plus grows the disk when the world is brought back, so the same download may begin.
      const big = await server()
      const start = await h.app.backups.beginWorldUpload(big.owner, big.id, {
        fileName: 'world.tar.gz',
        sizeBytes: 3 * 1024 ** 3 + 1,
      })
      expect(start.url).toContain('http')
    }, 60_000)

    test('a download Blockly can’t run is refused before it is kept', async () => {
      const { owner, id } = await server()
      const cases: Array<[Record<string, string | Uint8Array>, { code: string; message: string }]> = [
        [
          { 'world/level.dat': levelDat('26.3') },
          {
            code: 'invalid_upload',
            message: 'This isn’t a Cubepals download: it has no server.properties naming its world.',
          },
        ],
        [
          { 'server.properties': 'level-name=world\n', 'world/level.dat': levelDat('99.1') },
          {
            code: 'version_downgrade',
            message:
              "This world was last played on Minecraft 99.1, newer than this server's 26.3. Move the server to 99.1 first, then try again.",
          },
        ],
        [
          { 'server.properties': 'level-name=world\n', 'world/level.dat': 'not nbt' },
          { code: 'invalid_upload', message: 'The world’s world/level.dat can’t be read.' },
        ],
      ]
      for (const [files, expected] of cases)
        expect(await refusal(uploadWorld(owner, id, await tarball(files)))).toEqual(expected)
      expect(await refusal(uploadWorld(owner, id, new TextEncoder().encode('not a tarball at all')))).toEqual(
        {
          code: 'invalid_upload',
          message: 'This file isn’t a whole world download (.tar.gz).',
        },
      )
      expect(
        await refusal(h.app.backups.beginWorldUpload(owner, id, { fileName: 'world.zip', sizeBytes: 10 })),
      ).toMatchObject({ code: 'invalid_upload' })
      // Refused uploads keep nothing as a backup; their files are collected once abandoned.
      expect((await listBackups(h.db, id)).filter((b) => b.trigger === 'uploaded')).toEqual([])
      const pending = await h.db
        .select()
        .from(schema.pendingUploads)
        .where(eq(schema.pendingUploads.serverId, id))
      expect(pending.length).toBe(4)
      await h.db
        .update(schema.pendingUploads)
        .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
        .where(eq(schema.pendingUploads.serverId, id))
      expect((await h.app.artifacts.collectGarbage()).uploads).toBeGreaterThanOrEqual(4)
      for (const upload of pending) expect(await store.head(upload.key)).toBeNull()
    }, 60_000)
  })

  describe('collection and mirroring', () => {
    test('blobs nothing pins leave the store after the grace period; pinned ones stay', async () => {
      const { owner, id } = await server()
      const unused = await uploadJar(owner, id, fabricJar(`unused-${randomUUID().slice(0, 6)}`))
      const used = await uploadJar(owner, id, fabricJar(`used-${randomUUID().slice(0, 6)}`))
      const plan = await h.app.mods.plan(owner, id, { addUploads: [used.id] })
      if (plan.kind !== 'ok') throw new Error('No plan')
      await h.app.mods.apply(
        owner,
        id,
        { addUploads: [used.id] },
        plan.mods.map((m) => m.artifact.sha512),
        randomUUID(),
      )
      await h.settled(id, 20_000)

      // Within the grace period, nothing goes.
      await h.app.artifacts.collectGarbage()
      expect(await store.head(unused.key)).not.toBeNull()

      const weekAgo = new Date(Date.now() - 8 * 86_400_000)
      await h.db.update(schema.storedArtifacts).set({ createdAt: weekAgo })
      await h.app.artifacts.collectGarbage()
      expect(await store.head(unused.key)).toBeNull()
      expect(await h.db.select().from(schema.modUploads).where(eq(schema.modUploads.id, unused.id))).toEqual(
        [],
      )
      expect(await store.head(used.key)).not.toBeNull()
      expect((await h.app.modQueries.uploads(owner, id)).map((u) => u.id)).toContain(used.id)
    }, 40_000)

    test('a catalog jar a revision pins is mirrored by its queue, before any boot needs it', async () => {
      const { owner, id } = await server()
      await h.app.servers.stop(owner, id, randomUUID())
      await h.until(id, 'stopped')
      await h.settled(id)
      const file = cdn.file(`mirrored-${randomUUID().slice(0, 6)}`)
      written.push(`artifacts/${file.sha512}`)
      h.catalog.publish(
        {
          projectId: 'queued',
          slug: 'queued',
          name: 'Queued',
          summary: '',
          iconUrl: null,
          environments: [],
          downloads: 1,
        },
        [
          {
            versionId: 'queued-1',
            projectId: 'queued',
            versionLabel: '1',
            channel: 'release',
            state: 'listed',
            environment: 'server_only',
            loaders: ['fabric'],
            gameVersions: ['26.3'],
            publishedAt: new Date(),
            file,
            dependencies: [],
          } satisfies CatalogVersion,
        ],
      )
      const downloads = cdn.downloads
      const plan = await h.app.mods.plan(owner, id, { add: [{ projectId: 'queued' }] })
      if (plan.kind !== 'ok') throw new Error('No plan')
      await h.app.mods.apply(
        owner,
        id,
        { add: [{ projectId: 'queued' }] },
        plan.mods.map((m) => m.artifact.sha512),
        randomUUID(),
      )
      // The server stays stopped; only the queue fetches the jar.
      const deadline = Date.now() + 10_000
      let copied: Array<{ source: string }> = []
      while (Date.now() < deadline && copied.length === 0) {
        copied = await h.db
          .select({ source: schema.storedArtifacts.source })
          .from(schema.storedArtifacts)
          .where(eq(schema.storedArtifacts.sha512, file.sha512))
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(copied).toEqual([{ source: 'mirror' }])
      expect(cdn.downloads).toBe(downloads + 1)
      expect((await h.server(id)).lifecycle.status).toBe('stopped')
      expect(await store.head(`artifacts/${file.sha512}`)).toEqual({ sizeBytes: file.sizeBytes })
    }, 40_000)
  })
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Uploaded jars checked for malware before they run (§15.2): the lists' digests at upload, the
 * classes read on a worker, and a jar a list names later taken off at the next start. Every jar
 * here is built in the test; none is real malware.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { FakeMalwareLists } from '../../testing/malware.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import { classFile, fabricJar, unzipBytes, zipBytes } from '../../testing/uploads.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'

const digest = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('hex')

/** A Fabric mod whose one class holds what a test needs in its constant pool. */
const modWith = (id: string, constants: Omit<Parameters<typeof classFile>[0], 'name'>) =>
  zipBytes({
    'fabric.mod.json': new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, id, name: `Mod ${id}`, version: '1.0.0', environment: '*' }),
    ),
    [`net/example/${id}/Mod.class`]: classFile({ name: `net/example/${id}/Mod`, ...constants }),
  })

let h: Harness
const store = new MemoryStore()
const malware = new FakeMalwareLists()

beforeAll(async () => {
  if (!hasDatabase) return
  await store.start()
  h = await startHarness({ capabilities: { archives: store, billing: null, malware } })
}, 30_000)

afterAll(async () => {
  if (!hasDatabase) return
  await h.close()
  store.close()
})

beforeEach(async () => {
  malware.entries = []
  if (hasDatabase) await h.app.jarChecks.refresh()
})

const server = async () => {
  const owner = await h.user('Steve', 'plus')
  const created = await h.create(owner, { loader: 'fabric' })
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return { owner, id: created.id }
}

/** What the mods page does: ask, put the bytes where it was told, then say it is done. */
const upload = async (owner: UserActor, id: string, bytes: Uint8Array, fileName: string) => {
  const start = await h.app.mods.beginUpload(owner, id, {
    fileName,
    sizeBytes: bytes.length,
    sha512: digest('sha512', bytes),
  })
  if (start.kind === 'known') return start.upload
  const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
  expect(put.status).toBe(200)
  return h.app.mods.finishUpload(owner, id, start.ticket)
}

/** The upload as the mods page shows it once Cubepals has checked it. */
const checked = async (owner: UserActor, id: string, uploadId: string) => {
  for (let i = 0; i < 100; i++) {
    const view = (await h.app.modQueries.uploads(owner, id)).find((u) => u.id === uploadId)
    if (view !== undefined && !view.checking) return view
    await Bun.sleep(100)
  }
  throw new Error(`Upload ${uploadId} was never checked`)
}

const add = async (owner: UserActor, id: string, uploadId: string) => {
  const plan = await h.app.mods.plan(owner, id, { addUploads: [uploadId] })
  if (plan.kind !== 'ok') throw new Error('No plan')
  const before = await h.server(id)
  await h.app.mods.apply(
    owner,
    id,
    { addUploads: [uploadId] },
    plan.mods.map((m) => m.artifact.sha512),
    randomUUID(),
  )
  await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
  await h.settled(id, 20_000)
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }),
  )

describe.skipIf(!hasDatabase)('an uploaded jar', () => {
  test('a jar whose digest a list names is refused at upload, and nothing of it is kept', async () => {
    const { owner, id } = await server()
    const bytes = fabricJar(`bad-${randomUUID().slice(0, 6)}`)
    malware.entries = [{ kind: 'sha256', value: digest('sha256', bytes), family: 'Example' }]
    await h.app.jarChecks.refresh()

    expect(await refusal(upload(owner, id, bytes, 'fabric-example.jar'))).toEqual({
      code: 'invalid_upload',
      message: 'We didn’t install fabric-example.jar: it matches known malware.',
    })
    expect(await h.app.modQueries.uploads(owner, id)).toEqual([])
    const [check] = await h.app.jarChecks.list(['quarantined'])
    expect(check).toMatchObject({
      sha512: digest('sha512', bytes),
      finding: { match: `sha256 ${digest('sha256', bytes)}`, family: 'Example', source: 'test-list' },
    })
  }, 30_000)

  test('a class a list’s signature matches is quarantined after upload, and can’t be added', async () => {
    const { owner, id } = await server()
    malware.entries = [{ kind: 'string', value: '==cmds1', family: 'Example' }]
    await h.app.jarChecks.refresh()
    // The signature is in a jar it carries, as a Fabric mod carries its libraries.
    const suffix = randomUUID().slice(0, 6)
    const bytes = zipBytes({
      ...unzipBytes(modWith(`sig${suffix}`, {})),
      'META-INF/jars/library.jar': modWith(`lib${suffix}`, { strings: ['==cmds1'] }),
    })

    const sent = await upload(owner, id, bytes, 'sneaky.jar')
    // Until it has been read it can't go on.
    expect(await refusal(h.app.mods.plan(owner, id, { addUploads: [sent.id] }))).toMatchObject({
      code: 'invalid_upload',
    })
    expect(await checked(owner, id, sent.id)).toMatchObject({
      refusal: 'We didn’t install sneaky.jar: it matches known malware.',
    })
    expect(await refusal(h.app.mods.plan(owner, id, { addUploads: [sent.id] }))).toEqual({
      code: 'invalid_upload',
      message: 'We didn’t install sneaky.jar: it matches known malware.',
    })
    const [check] = await h.app.jarChecks.list(['quarantined'])
    expect(check?.finding).toEqual({ match: '==cmds1', family: 'Example', source: 'test-list' })
  }, 30_000)

  test('a jar its code only flags installs, with a note for operators', async () => {
    const { owner, id } = await server()
    const bytes = modWith(`exec${randomUUID().slice(0, 6)}`, {
      members: ['java/lang/Runtime.exec'],
      classes: ['sun/misc/Unsafe'],
    })
    const sent = await upload(owner, id, bytes, 'runs-things.jar')
    expect(await checked(owner, id, sent.id)).toMatchObject({ refusal: null })
    const flagged = (await h.app.jarChecks.list(['flagged'])).find((c) => c.sha512 === sent.sha512)
    expect(flagged?.flags.map((f) => f.flag)).toEqual(['runs_commands', 'uses_unsafe'])
    expect(flagged?.uploads).toEqual([
      { uploadId: sent.id, ownerId: owner.userId, fileName: 'runs-things.jar' },
    ])

    await add(owner, id, sent.id)
    const revision = await loadRevision(h.db, (await h.server(id)).desiredRevisionId)
    expect(revision.mods.map((m) => m.artifact.sha512)).toContain(sent.sha512)
  }, 40_000)
})

describe.skipIf(!hasDatabase)('a jar already installed', () => {
  test('a clean jar installs as before, and one a list names later comes off at the next start', async () => {
    const { owner, id } = await server()
    const bytes = modWith(`clean${randomUUID().slice(0, 6)}`, { strings: ['Hello'] })
    const sent = await upload(owner, id, bytes, 'fabric-example.jar')
    expect(await checked(owner, id, sent.id)).toMatchObject({ refusal: null })
    const [row] = await h.db.select().from(schema.jarChecks).where(eq(schema.jarChecks.sha512, sent.sha512))
    expect(row).toMatchObject({ state: 'clean', sha1: digest('sha1', bytes), flags: [] })
    await add(owner, id, sent.id)
    expect(await h.minecraft.jars(id)).toHaveLength(1)
    // What the mod wrote stays the owner's, whatever becomes of the mod.
    const kept = h.minecraft.path(id, 'config/example.toml')
    await mkdir(dirname(kept), { recursive: true })
    await writeFile(kept, 'kept = true\n')

    malware.entries = [{ kind: 'sha1', value: digest('sha1', bytes), family: 'Example' }]
    expect(await h.app.jarChecks.refresh()).toBe(1)
    const [told] = h.mail.to(`${owner.userId}@example.test`)
    expect(told?.subject).toStartWith('We’re taking fabric-example.jar off ')
    expect((await h.app.modQueries.list(owner, id)).mods).toMatchObject([
      { id: `upload:${sent.id}`, malware: true },
    ])
    // It runs until the server next starts; then it is gone, and the rest is as it was.
    expect(await h.minecraft.jars(id)).toHaveLength(1)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect(await h.minecraft.jars(id)).toEqual([])
    expect(await readFile(kept, 'utf8')).toBe('kept = true\n')
    expect((await h.server(id)).lifecycle.status).toBe('running')
  }, 60_000)
})

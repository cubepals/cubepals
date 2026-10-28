// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The jars an uploaded pack keeps, held to the checks an uploaded jar gets (`mods/jar-checks.ts`):
 * one a list names by its digest or a signature matches refuses the pack, and one a list names
 * after the pack was built comes off its servers at their next start. Every jar here is built in
 * the test; none is real malware.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import type { PackImportView } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
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
})

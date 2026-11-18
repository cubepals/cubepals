// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plain Minecraft on Paper (`runsOnPaper`): what a new plain server runs where Paper has a build,
 * the way back to Mojang's own server, and the servers made before it, which keep what they ran.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  await h?.close()
})

/** Plain Minecraft on another release, or on or off Paper, applied. */
const plainOn = async (owner: UserActor, id: string, gameVersion: string, onPaper?: boolean) => {
  const before = (await h.server(id)).desiredRevisionId
  await h.app.mods.changeVersion(owner, id, { gameVersion, loader: 'vanilla', onPaper }, [], randomUUID())
  await h.until(id, (s) => s.lifecycle.status === 'running' && s.desiredRevisionId !== before)
  await h.settled(id)
}
const desired = async (id: string) => loadRevision(h.db, (await h.server(id)).desiredRevisionId)
const env = (id: string) => h.runtime.machine(id)?.spec.env ?? {}
const lastChange = async (id: string) => {
  const [row] = await h.db
    .select({ data: schema.auditLog.data })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.version_changed')))
    .orderBy(desc(schema.auditLog.at))
    .limit(1)
  return (row?.data as { changes?: unknown[] } | undefined)?.changes ?? []
}

describe.skipIf(!hasDatabase)('plain Minecraft on Paper', () => {
  test('a new plain server runs on Paper where Paper has a build, and on Mojang’s own where not', async () => {
    const owner = await h.user('Steve', 'plus')
    const direct = await h.create(owner, { name: 'Direct', gameVersion: '26.2' })
    expect(await desired(direct.id)).toMatchObject({ loader: 'vanilla', loaderVersion: '60' })
    // A plan runs so many servers at a time: each is someone else's.
    const survival = await h.create(await h.user('Alex', 'plus'), {
      name: 'Survival',
      from: { kind: 'template', key: 'survival', gameVersion: '26.2' },
    })
    expect(await desired(survival.id)).toMatchObject({ loader: 'vanilla', loaderVersion: '60' })
    await h.until(survival.id, 'running')
    await h.settled(survival.id)
    expect(env(survival.id)).toMatchObject({ TYPE: 'PAPER', PAPER_BUILD: '60' })
    // Plain 26.3 stays on Mojang's own server, though Cubepals offers Paper on it.
    const newest = await h.create(await h.user('Robin', 'plus'), { name: 'Newest', gameVersion: '26.3' })
    expect((await desired(newest.id)).loaderVersion).toBeNull()
  }, 60_000)

  test('a Paper build list that is down makes the server on Mojang’s own, never refuses it', async () => {
    const owner = await h.user('Alex', 'plus')
    h.loaderBuilds.down.add('paper')
    try {
      const made = await h.create(owner, { name: 'Down', gameVersion: '26.2' })
      expect((await desired(made.id)).loaderVersion).toBeNull()
    } finally {
      h.loaderBuilds.down.clear()
    }
  })

  test('the owner goes back to Mojang’s own server and onto Paper again, the change said', async () => {
    const owner = await h.user('Robin', 'plus')
    const { id } = await h.create(owner, { name: 'Back', gameVersion: '26.2' })
    await h.until(id, 'running')
    await h.settled(id)
    await plainOn(owner, id, '26.2', false)
    expect(await desired(id)).toMatchObject({ loader: 'vanilla', loaderVersion: null })
    expect(env(id).TYPE).toBe('VANILLA')
    expect(await lastChange(id)).toEqual([{ field: 'onPaper', from: true, to: false }])
    // Asking for what it already runs changes nothing.
    const now = (await h.server(id)).desiredRevisionId
    await h.app.mods.changeVersion(
      owner,
      id,
      { gameVersion: '26.2', loader: 'vanilla', onPaper: false },
      [],
      randomUUID(),
    )
    expect((await h.server(id)).desiredRevisionId).toBe(now)
    await plainOn(owner, id, '26.2', true)
    expect(env(id)).toMatchObject({ TYPE: 'PAPER', PAPER_BUILD: '60' })
  }, 60_000)

  test('a server made before Paper was the default keeps Mojang’s own through its changes', async () => {
    const owner = await h.user('Sam', 'plus')
    const { id } = await h.create(owner, { name: 'Older', gameVersion: '1.21.11' })
    await h.until(id, 'running')
    await h.settled(id)
    // As every plain revision made before this change is: no build.
    await h.db
      .update(schema.serverRevisions)
      .set({ loaderVersion: null })
      .where(eq(schema.serverRevisions.serverId, id))
    await plainOn(owner, id, '26.2')
    expect(await desired(id)).toMatchObject({ gameVersion: '26.2', loaderVersion: null })
    expect(env(id).TYPE).toBe('VANILLA')
  }, 60_000)

  test('a world on Paper moves to a mod loader, and rolling back puts it on Paper again', async () => {
    // Fabric comes with Plus.
    const owner = await h.user('Steve', 'plus')
    const { id } = await h.create(owner, { name: 'Fabric Mill', gameVersion: '26.2' })
    await h.until(id, 'running')
    await h.settled(id)
    const first = (await h.server(id)).desiredRevisionId
    await h.app.mods.changeVersion(owner, id, { gameVersion: '26.2', loader: 'fabric' }, [], randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.desiredRevisionId !== first)
    await h.settled(id)
    expect(h.runtime.machine(id)?.spec.env.TYPE).toBe('FABRIC')
    await h.app.revisions.rollback(owner, id, first, randomUUID())
    await h.settled(id)
    // Plain Minecraft again, on Paper as it was made.
    expect(h.runtime.machine(id)?.spec.env.TYPE).toBe('PAPER')
    expect(h.runtime.machine(id)?.spec.env.PAPER_BUILD).toBe('60')
    const applies = (await h.operations(id)).filter((op) => op.kind === 'apply')
    expect(applies.at(-1)?.status).toBe('succeeded')
  })
})

describe.skipIf(!hasDatabase)('Paper on 26.3', () => {
  test('a Paper server is made on 26.3, with Paper’s build', async () => {
    const made = await h.create(await h.user('Sky', 'plus'), { loader: 'paper', gameVersion: '26.3' })
    expect(await desired(made.id)).toMatchObject({
      loader: 'paper',
      gameVersion: '26.3',
      loaderVersion: '60',
    })
    await h.until(made.id, 'running')
    await h.settled(made.id)
    expect(env(made.id)).toMatchObject({ TYPE: 'PAPER', VERSION: '26.3', PAPER_BUILD: '60' })
  }, 60_000)

  test('on 26.3, plain servers start on Mojang’s own, a world on Paper keeps it, and an owner can choose it', async () => {
    const owner = await h.user('Jo', 'plus')
    const { id } = await h.create(owner, { name: 'Ahead', gameVersion: '26.2' })
    await h.until(id, 'running')
    await h.settled(id)
    // A world already on Paper moving up keeps the server it runs on.
    await plainOn(owner, id, '26.3')
    expect(await desired(id)).toMatchObject({ gameVersion: '26.3', loaderVersion: '60' })
    expect(env(id)).toMatchObject({ TYPE: 'PAPER', PAPER_BUILD: '60' })

    // A new plain 26.3 server is on Mojang's own, and its owner's "Run on Paper" moves it.
    const fresh = await h.create(owner, { name: 'Fresh', gameVersion: '26.3' })
    await h.until(fresh.id, 'running')
    await h.settled(fresh.id)
    expect((await desired(fresh.id)).loaderVersion).toBeNull()
    await plainOn(owner, fresh.id, '26.3', true)
    expect(await desired(fresh.id)).toMatchObject({ gameVersion: '26.3', loaderVersion: '60' })
    expect(await lastChange(fresh.id)).toContainEqual({ field: 'onPaper', from: false, to: true })
  }, 90_000)
})

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

describe.skipIf(!hasDatabase)('plain Minecraft on Paper', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
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
    // Cubepals offers no Paper on 26.3: Mojang's own server, as before.
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

  test('a world on Paper moving to a release Paper has no build for runs on Mojang’s own', async () => {
    const owner = await h.user('Jo', 'plus')
    const { id } = await h.create(owner, { name: 'Ahead', gameVersion: '26.2' })
    await h.until(id, 'running')
    await h.settled(id)
    await plainOn(owner, id, '26.3')
    expect(await desired(id)).toMatchObject({ gameVersion: '26.3', loaderVersion: null })
    expect(env(id).TYPE).toBe('VANILLA')
    expect(await lastChange(id)).toContainEqual({ field: 'onPaper', from: true, to: false })
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

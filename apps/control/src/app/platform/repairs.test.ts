/**
 * An admin fixing someone's server, end to end against the fake provider: each action refused to
 * anyone but an admin and without a reason, done the owner's way as `admin:<id>`, and audited with
 * why.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import { ServerRepairs } from './repairs.ts'

describe.skipIf(!hasDatabase)('admin server repairs', () => {
  let h: Harness
  let repairs: ServerRepairs

  beforeAll(async () => {
    h = await startHarness()
    repairs = new ServerRepairs({ db: h.db, servers: h.app.servers, backups: h.app.backups })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const setUp = async () => {
    const owner = await h.user()
    const staff = await h.user('Staff')
    const admin = { kind: 'admin' as const, userId: staff.userId }
    const { id } = await h.create(owner, { name: 'Castle' })
    await h.until(id, 'running')
    await h.settled(id)
    return { owner, admin, id }
  }
  const audited = (id: string, action: string) =>
    h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, action)))
  const stop = async (owner: UserActor, id: string) => {
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
  }

  test('only an admin, and only saying why', async () => {
    const { owner, admin, id } = await setUp()
    const outsider = await h.user()
    for (const actor of [owner, outsider]) {
      await expect(repairs.start(actor, id, randomUUID(), 'mine')).rejects.toThrow('not found')
      await expect(repairs.trash(actor, id, 'Castle', 'mine')).rejects.toThrow('not found')
      await expect(repairs.untrash(actor, id, 'mine')).rejects.toThrow('not found')
      await expect(
        repairs.restore(
          actor,
          id,
          { backupId: randomUUID(), withConfiguration: false },
          randomUUID(),
          'mine',
        ),
      ).rejects.toThrow('not found')
    }
    await expect(repairs.start(admin, id, randomUUID(), '  ')).rejects.toThrow('Say why')
    await expect(repairs.trash(admin, id, 'Castle', '')).rejects.toThrow('Say why')
    expect((await h.server(id)).lifecycle.status).toBe('running')
  })

  test('an admin starts a stopped server as its owner would, and it is audited once', async () => {
    const { owner, admin, id } = await setUp()
    await stop(owner, id)
    await repairs.start(admin, id, randomUUID(), 'Owner wrote in: it would not start')
    await h.until(id, 'running')
    const [start] = (await h.operations(id)).filter((op) => op.kind === 'start')
    expect(start?.requestedBy).toBe(`admin:${admin.userId}`)
    expect(await audited(id, 'server.admin_started')).toMatchObject([
      { actor: `admin:${admin.userId}`, data: { reason: 'Owner wrote in: it would not start' } },
    ])
    // Running already: nothing to do, and nothing recorded as done.
    await repairs.start(admin, id, randomUUID(), 'again')
    expect(await audited(id, 'server.admin_started')).toHaveLength(1)
  })

  test('an admin sends a server to the trash for its owner’s window, and takes it back out', async () => {
    const { admin, id } = await setUp()
    await expect(repairs.trash(admin, id, 'Not it', 'Abuse report')).rejects.toThrow('name exactly')
    await repairs.trash(admin, id, 'Castle', 'Abuse report')
    const trashed = await h.server(id)
    expect(trashed.lifecycle.status).toBe('deleted')
    // Kept as long as the owner's plan keeps a trashed server, not purged at the next sweep.
    const days = ((trashed.purgeAfter?.getTime() ?? 0) - (trashed.deletedAt?.getTime() ?? 0)) / 86_400_000
    expect(days).toBeGreaterThan(1)
    expect(await audited(id, 'server.deleted')).toMatchObject([{ actor: `admin:${admin.userId}` }])
    expect(await audited(id, 'server.admin_trashed')).toMatchObject([
      { actor: `admin:${admin.userId}`, data: { reason: 'Abuse report' } },
    ])
    await h.settled(id)

    const back = await repairs.untrash(admin, id, 'Report was wrong')
    expect(back.lifecycle.status).toBe('stopped')
    expect(await audited(id, 'server.undeleted')).toMatchObject([{ actor: `admin:${admin.userId}` }])
    expect(await audited(id, 'server.admin_untrashed')).toMatchObject([
      { actor: `admin:${admin.userId}`, data: { reason: 'Report was wrong' } },
    ])
  })

  test('an admin restores one of the server’s backups the way its owner would', async () => {
    const { owner, admin, id } = await setUp()
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [backup] = (await listBackups(h.db, id)).filter(
      (b) => b.trigger === 'manual' && b.status === 'ready',
    )
    if (backup === undefined) throw new Error('No backup was taken')
    // The admin sees what its owner sees on the backups page.
    const list = await h.app.backupQueries.list(admin, id)
    expect(list.backups.map((b) => b.id)).toContain(backup.id)

    await repairs.restore(
      admin,
      id,
      { backupId: backup.id, withConfiguration: false },
      randomUUID(),
      'World corrupted',
    )
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await audited(id, 'server.restore_requested')).toMatchObject([
      { actor: `admin:${admin.userId}`, data: { backupId: backup.id } },
    ])
    expect(await audited(id, 'server.admin_restored')).toMatchObject([
      { actor: `admin:${admin.userId}`, data: { reason: 'World corrupted', backupId: backup.id } },
    ])
  })
})

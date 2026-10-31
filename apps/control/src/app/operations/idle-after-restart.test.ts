// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A change or a restore on a running server takes it down and brings it back inside the same run:
 * its usage interval stays open, but nobody could join while it was down. Its idle time counts
 * again from when it is running again, so one close to its idle limit isn't put to sleep the moment
 * it comes back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, isNull } from 'drizzle-orm'
import { backdateRun } from '../../testing/backdated-run.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import { loadRevision } from '../servers/persistence.ts'
import { IDLE_GRACE_MS } from './schedules.ts'

describe.skipIf(!hasDatabase)('idle time after a change or a restore', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const openRunStart = async (id: string) => {
    const [run] = await h.db
      .select({ startedAt: schema.powerIntervals.startedAt })
      .from(schema.powerIntervals)
      .where(and(eq(schema.powerIntervals.serverId, id), isNull(schema.powerIntervals.stoppedAt)))
    if (run === undefined) throw new Error('no open run')
    return run.startedAt
  }
  const readyAt = async (id: string) => {
    const [row] = await h.db
      .select({ readyAt: schema.minecraftServers.readyAt })
      .from(schema.minecraftServers)
      .where(eq(schema.minecraftServers.id, id))
    if (row?.readyAt == null) throw new Error('not running')
    return row.readyAt
  }

  /** A running server nobody has played on, a minute short of its plan's idle time. */
  const nearlyIdle = async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.db.delete(schema.serverActivity).where(eq(schema.serverActivity.serverId, id))
    // The plan's idle time, as the page says it: from when it became running to when it sleeps.
    const sleepsAt = (await h.app.queries.get(owner, id)).sleepsAt
    if (sleepsAt === null) throw new Error('the plan never sleeps an idle server')
    const idleMs = Date.parse(sleepsAt) - (await readyAt(id)).getTime()
    await backdateRun(h.db, id, idleMs - MINUTE_MS)
    return { owner, id, idleMs }
  }

  /** Back up from the restart, still in the run it was in: its idle time counts from now. */
  const cameBack = async (owner: UserActor, id: string, began: Date, idleMs: number) => {
    expect((await openRunStart(id)).getTime()).toBe(began.getTime())
    const due = (await readyAt(id)).getTime() + idleMs
    expect((await h.app.queries.get(owner, id)).sleepsAt).toBe(new Date(due).toISOString())

    // Past when the run would have slept had it never gone down, it stays up...
    const grace = Date.now() + IDLE_GRACE_MS
    const soon = new Date(Math.max(grace, began.getTime() + idleMs + MINUTE_MS))
    expect(soon.getTime()).toBeLessThan(due)
    expect(await h.app.schedules.evaluateIdle(await h.server(id), soon)).toBe('recently_active')
    // ...and sleeps once its whole idle time has passed since it came back.
    expect(await h.app.schedules.evaluateIdle(await h.server(id), new Date(Math.max(grace, due)))).toBe(
      'stopped',
    )
    expect((await h.until(id, 'stopped')).lifecycle.stopReason).toBe('idle')
  }

  test('a change that restarts it gives it its whole idle time again', async () => {
    const { owner, id, idleMs } = await nearlyIdle()
    const began = await openRunStart(id)
    const settings = (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
    await h.app.revisions.changeSettings(owner, id, { ...settings, motd: 'Back soon' }, randomUUID())
    await h.until(id, (s) => s.lifecycle.status !== 'updating', 20_000)
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    await cameBack(owner, id, began, idleMs)
  }, 60_000)

  test('a restore gives it its whole idle time again', async () => {
    const { owner, id, idleMs } = await nearlyIdle()
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    const [backup] = (await listBackups(h.db, id)).filter(
      (b) => b.trigger === 'manual' && b.status === 'ready',
    )
    if (backup === undefined) throw new Error('No backup was taken')
    const began = await openRunStart(id)
    await h.app.backups.restoreBackup(owner, id, backup.id, randomUUID(), { withConfiguration: false })
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    await cameBack(owner, id, began, idleMs)
  }, 60_000)
})

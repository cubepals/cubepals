// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Someone who wants to play a server while a restore is bringing a backup back onto it. A restore
 * of a stopped server puts it back to sleep when it is done; a join, or its owner pressing Start,
 * meanwhile, has it stay up instead, from the boot the restore made, and nothing starts it a second
 * time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  await h?.close()
})

/** A server with a backup, left as `then`. */
const withBackup = async (then: 'running' | 'stopped') => {
  const owner = await h.user()
  const { id, slug } = await h.create(owner)
  await h.until(id, 'running')
  await h.settled(id)
  await h.app.backups.createBackup(owner, id, randomUUID())
  await h.settled(id)
  const [backup] = (await listBackups(h.db, id)).filter((b) => b.trigger === 'manual' && b.status === 'ready')
  if (backup === undefined) throw new Error('No backup was taken')
  if (then === 'stopped') {
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
  }
  return { owner, id, slug, backupId: backup.id }
}

/**
 * The restore held just after its boot let players in, as a big world holds it there in
 * production: resolved once it is, and let go by the returned function.
 */
const holdAfterLetIn = () => {
  const recent = h.minecraft.recent
  const reached = Promise.withResolvers<void>()
  const go = Promise.withResolvers<void>()
  h.minecraft.recent = async (handle, limit) => {
    h.minecraft.recent = recent
    reached.resolve()
    await go.promise
    return recent.call(h.minecraft, handle, limit)
  }
  return { reached: reached.promise, release: () => go.resolve() }
}

const restore = (owner: UserActor, id: string, backupId: string) =>
  h.app.backups.restoreBackup(owner, id, backupId, randomUUID(), { withConfiguration: false })

const boots = async (id: string) => (await h.operations(id)).filter((op) => op.kind === 'start')

describe.skipIf(!hasDatabase)('wanting to play a server a restore is bringing back', () => {
  test('a join while a stopped server’s restore lets players in keeps it up, booted once', async () => {
    const { owner, id, slug, backupId } = await withBackup('stopped')
    const startsBefore = (await boots(id)).length
    const held = holdAfterLetIn()
    await restore(owner, id, backupId)
    await held.reached
    expect((await h.server(id)).lifecycle.status).toBe('restoring')

    // A player joins while it is still on "Letting players in".
    const joining = h.app.edge.wake(`${slug}.play.test`)
    for (const deadline = Date.now() + 2_000; Date.now() < deadline; ) {
      const [op] = (await h.operations(id)).filter((o) => o.kind === 'restore')
      if (op?.input.running === true) break
      await Bun.sleep(20)
    }
    held.release()

    // The join is handed to the server the restore booted: it never goes back to sleep for it.
    expect((await joining).outcome).toBe('ready')
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await boots(id)).toHaveLength(startsBefore)
    const [run] = await h.db
      .select({ woken: schema.powerIntervals.woken })
      .from(schema.powerIntervals)
      .where(sql`${schema.powerIntervals.serverId} = ${id} and ${schema.powerIntervals.stoppedAt} is null`)
    // A connection kept it up, so the run is a woken one: it sleeps after the probation unjoined.
    expect(run?.woken).toBe(true)
  }, 60_000)

  test('its owner pressing Start meanwhile keeps it up too, with the whole idle time', async () => {
    const { owner, id, backupId } = await withBackup('stopped')
    const held = holdAfterLetIn()
    await restore(owner, id, backupId)
    await held.reached
    await h.app.servers.start(owner, id, randomUUID())
    held.release()
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    const [run] = await h.db
      .select({ woken: schema.powerIntervals.woken })
      .from(schema.powerIntervals)
      .where(sql`${schema.powerIntervals.serverId} = ${id} and ${schema.powerIntervals.stoppedAt} is null`)
    expect(run?.woken).toBe(false)
  }, 60_000)

  test('a restore nobody wants to play meanwhile leaves a stopped server stopped', async () => {
    const { owner, id, backupId } = await withBackup('stopped')
    await restore(owner, id, backupId)
    await h.until(id, (s) => s.lifecycle.status !== 'restoring', 20_000)
    await h.settled(id, 20_000)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
  }, 60_000)
})

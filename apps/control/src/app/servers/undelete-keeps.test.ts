// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Taking a server back out of the trash: one made for a while stays so, with the time it had left
 * when it went in, and an unplayed world's idle clock starts over, so neither sweep sends it
 * straight back. It counts against the plan's servers as a new one would.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('a server taken back out of the trash', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a server made for a while comes back with the time it had left, and goes when that is up', async () => {
    const owner = await h.user()
    const created = await h.create(owner, { temporary: true })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    const server = await h.server(created.id)
    await h.app.servers.deleteServer(owner, created.id, server.name)
    const trashed = await h.server(created.id)
    const left = (trashed.expiresAt as Date).getTime() - (trashed.deletedAt as Date).getTime()
    await h.settled(created.id)

    // Its owner restores it: it is still made for a while, with the same time left.
    const at = Date.now()
    const back = await h.app.servers.undeleteServer(owner, created.id)
    expect(back.lifecycle.status).toBe('stopped')
    const end = (back.expiresAt as Date).getTime()
    expect(end).toBeGreaterThanOrEqual(at + left)
    expect(end).toBeLessThanOrEqual(Date.now() + left)

    // The next sweep leaves it; one past its end sends it to the trash again.
    expect(await h.app.schedules.expirySweep(new Date(at + 5 * MINUTE_MS))).toBe(0)
    expect((await h.server(created.id)).lifecycle.status).toBe('stopped')
    expect(await h.app.schedules.expirySweep(new Date(end + SECOND_MS))).toBe(1)
    expect((await h.server(created.id)).lifecycle.status).toBe('deleted')
    await h.settled(created.id)
  }, 60_000)

  test('a server comes back out of the trash only while the plan has room for it', async () => {
    const owner = await h.user('Fen', 'free')
    const { maxServers } = entitlementsFor('free')
    const trashed = await h.create(owner, { name: 'Trashed' })
    await h.until(trashed.id, 'running')
    await h.settled(trashed.id)
    await h.app.servers.deleteServer(owner, trashed.id, 'Trashed')
    await h.settled(trashed.id)
    for (let n = 0; n < maxServers; n++) {
      const made = await h.create(owner, { name: `Kept ${n}` })
      await h.settled(made.id)
    }
    await expect(h.app.servers.undeleteServer(owner, trashed.id)).rejects.toThrow(
      'Delete one to restore this',
    )
    expect((await h.server(trashed.id)).lifecycle.status).toBe('deleted')
  }, 60_000)

  test('an unplayed world taken back out of the trash is not deleted again by the next daily sweep', async () => {
    await h.db.update(schema.platformControls).set({ expiringEnabled: true })
    const owner = await h.user('Ada', 'free')
    const created = await h.create(owner, { name: 'Unplayed' })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.servers.stop(owner, created.id, randomUUID())
    await h.until(created.id, 'stopped')
    await h.settled(created.id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 340 * DAY_MS) })
      .where(eq(schema.minecraftServers.id, created.id))
    const sweep = (days: number) => h.app.schedules.retentionSweep(new Date(Date.now() + days * DAY_MS))
    // Warned a month before and a week before, then into the trash, as retention.test.ts walks it.
    await sweep(0)
    await sweep(20)
    await sweep(28)
    expect((await h.server(created.id)).lifecycle.status).toBe('deleted')
    await h.settled(created.id)

    // Its owner restores it from the trash that same day.
    await h.app.servers.undeleteServer(owner, created.id)
    const mails = h.mail.sent.length
    // The next day's sweep neither deletes it nor warns again.
    await sweep(29)
    expect((await h.server(created.id)).lifecycle.status).toBe('stopped')
    expect(h.mail.sent.length).toBe(mails)
  }, 60_000)
})

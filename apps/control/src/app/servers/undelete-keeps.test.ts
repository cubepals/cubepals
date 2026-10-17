// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Taking a server back out of the trash keeps it, as `keep` and `keepWorld` do: one made for a
 * while has no end date any more, and an unplayed world's idle clock starts over, so neither
 * sweep sends it straight back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

describe.skipIf(!hasDatabase)('a server taken back out of the trash', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('taken back out of the trash after its time ran out, the next expiry sweep leaves it alone', async () => {
    const owner = await h.user()
    const created = await h.create(owner, { temporary: true })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    const past = new Date((created.expiresAt as Date).getTime() + SECOND_MS)
    expect(await h.app.schedules.expirySweep(past)).toBe(1)
    expect((await h.server(created.id)).lifecycle.status).toBe('deleted')
    await h.settled(created.id)

    // Its owner restores it from the trash.
    const back = await h.app.servers.undeleteServer(owner, created.id)
    expect(back.lifecycle.status).toBe('stopped')
    expect(back.expiresAt).toBeNull()

    // Five minutes later, the next sweep.
    expect(await h.app.schedules.expirySweep(new Date(past.getTime() + 5 * MINUTE_MS))).toBe(0)
    expect((await h.server(created.id)).lifecycle.status).toBe('stopped')
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

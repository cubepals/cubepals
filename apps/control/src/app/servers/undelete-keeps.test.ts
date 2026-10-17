// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Taking a server back out of the trash: one made for a while stays so, with at least the time a
 * new one starts with; an unplayed world's idle clock starts over. Neither sweep sends it straight
 * back, and it counts against the plan's servers as a new one would.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { TEMPORARY_HOURS } from './temporary.ts'

describe.skipIf(!hasDatabase)('a server taken back out of the trash', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a server made for a while deleted with minutes left comes back with a full allowance', async () => {
    const owner = await h.user()
    const created = await h.create(owner, { temporary: true })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.db
      .update(schema.minecraftServers)
      .set({ expiresAt: new Date(Date.now() + 3 * MINUTE_MS) })
      .where(eq(schema.minecraftServers.id, created.id))
    await h.app.servers.deleteServer(owner, created.id, (await h.server(created.id)).name)
    await h.settled(created.id)
    // The trash line says it lasts a new one's time once restored, not the minutes it had.
    const [listed] = (await h.app.queries.trash(owner)).filter((s) => s.id === created.id)
    expect(listed?.lastsOnceRestored).toBe(TEMPORARY_HOURS * HOUR_MS)

    const at = Date.now()
    const back = await h.app.servers.undeleteServer(owner, created.id)
    expect(back.lifecycle.status).toBe('stopped')
    const end = (back.expiresAt as Date).getTime()
    expect(end).toBeGreaterThanOrEqual(at + TEMPORARY_HOURS * HOUR_MS)
    expect(end).toBeLessThanOrEqual(Date.now() + TEMPORARY_HOURS * HOUR_MS)
    // The next sweep, past the minutes it had, leaves it; one past its new end takes it.
    expect(await h.app.schedules.expirySweep(new Date(at + 5 * MINUTE_MS))).toBe(0)
    expect((await h.server(created.id)).lifecycle.status).toBe('stopped')
    expect(await h.app.schedules.expirySweep(new Date(end + SECOND_MS))).toBe(1)
    await h.settled(created.id)
  }, 60_000)

  /** A server made for a while, sent to the trash by the expiry sweep once its time ran out. */
  const timedOut = async (owner: Awaited<ReturnType<Harness['user']>>, name: string) => {
    const created = await h.create(owner, { name, temporary: true })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.db
      .update(schema.minecraftServers)
      .set({ expiresAt: new Date(Date.now() - MINUTE_MS) })
      .where(eq(schema.minecraftServers.id, created.id))
    expect(await h.app.schedules.expirySweep(new Date())).toBe(1)
    await h.settled(created.id)
    return created.id
  }

  test('a server made for a while whose time ran out comes back with the time a new one has', async () => {
    const owner = await h.user()
    const id = await timedOut(owner, 'Evening')
    // The trash says how long it lasts once restored.
    const [listed] = (await h.app.queries.trash(owner)).filter((s) => s.id === id)
    expect(listed?.lastsOnceRestored).toBe(TEMPORARY_HOURS * HOUR_MS)

    const at = Date.now()
    const back = await h.app.servers.undeleteServer(owner, id)
    const end = (back.expiresAt as Date).getTime()
    expect(end).toBeGreaterThanOrEqual(at + TEMPORARY_HOURS * HOUR_MS)
    expect(end).toBeLessThanOrEqual(Date.now() + TEMPORARY_HOURS * HOUR_MS)
    // The next sweep leaves it; one past its new end sends it to the trash again.
    expect(await h.app.schedules.expirySweep(new Date(at + 5 * MINUTE_MS))).toBe(0)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(await h.app.schedules.expirySweep(new Date(end + SECOND_MS))).toBe(1)
    await h.settled(id)
  }, 60_000)

  test('a server comes back out of the trash only while the plan has room for it', async () => {
    const owner = await h.user('Fen', 'free')
    const { maxServers } = entitlementsFor('free')
    // Made for a while and out of time: restoring it would give it a new one's time.
    const trashed = { id: await timedOut(owner, 'Trashed') }
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

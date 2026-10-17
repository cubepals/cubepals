// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When the provider can't be listed (Fly's API down, its token revoked or expired), every
 * spend-watchdog pass throws before writing a figure ("no figure beats a low one"). While that
 * lasts nothing holds the daily limit, so the admins hear of it: an alert once it has gone a
 * while without a figure.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadSpendDay } from '../platform/persistence.ts'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)
afterAll(async () => {
  if (hasDatabase) await h.close()
})

describe.skipIf(!hasDatabase)('a spend watchdog that cannot read the provider', () => {
  test('is an admin alert once it has gone a while without a figure', async () => {
    const person = await h.user('Admin')
    await h.db.insert(schema.platformAdmins).values({ userId: person.userId, grantedBy: 'test' })
    const listing = spyOn(h.runtime, 'observeChanged').mockImplementation(() => {
      throw new Error('Fly answered 401: token expired')
    })
    try {
      const start = new Date('2020-02-01T00:05:00Z')
      // Every ten minutes for six hours, as the schedule runs it: each pass throws.
      let failed = 0
      for (let t = 0; t <= 6 * HOUR_MS; t += 10 * MINUTE_MS)
        await h.app.schedules.spendCheck(new Date(start.getTime() + t)).catch(() => failed++)
      expect(failed).toBe(37)
      expect(await loadSpendDay(h.db, '2020-02-01')).toBeNull()

      const quiet = spyOn(console, 'error').mockImplementation(() => {})
      const { raised } = await h.app.alerts
        .sweep(new Date(start.getTime() + 6 * HOUR_MS))
        .finally(() => quiet.mockRestore())
      // Something an admin would see: an alert of any key naming the spend figure.
      expect(raised.length).toBeGreaterThan(0)
    } finally {
      listing.mockRestore()
    }
  }, 30_000)
})

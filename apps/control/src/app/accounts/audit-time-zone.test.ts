// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The owner's month follows the time zone their browser last reported, read at every check. A
 * zone changed at the end of a month that is used up opens the next month's block early: the
 * hours played then fall back into the month already spent when the zone changes back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { nextMonthStart } from '../../domain/account/play-day.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

const PLUS_HOURS = entitlementsFor('plus').includedUnits ?? 0

describe.skipIf(!hasDatabase)('a time zone changed at the end of a month', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('opens no block of hours early', async () => {
    const actor = await h.user('Tavi', 'plus')
    await h.app.accounts.setTimeZone(actor, 'Etc/UTC')
    const server = await h.create(actor)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(actor, server.id, crypto.randomUUID(), 'user')
    await h.until(server.id, 'stopped')
    await h.settled(server.id)
    // The first whole month in UTC, and the one after it.
    const first = nextMonthStart(new Date(), 'Etc/UTC')
    const second = nextMonthStart(first, 'Etc/UTC')
    // 10:00 UTC on the last day of the first month, its 120 hours played.
    const at = new Date(second.getTime() - 14 * HOUR_MS)
    await h.db.insert(schema.powerIntervals).values({
      serverId: server.id,
      memoryTier: '3g',
      startedAt: new Date(at.getTime() - PLUS_HOURS * HOUR_MS),
      stoppedAt: at,
    })
    const check = () =>
      h.db.transaction((tx) =>
        h.app.policy.check(
          tx,
          actor.userId,
          { kind: 'start_server', runs: { tier: '3g', loader: 'paper', modded: false } },
          at,
          { lock: false },
        ),
      )
    expect(await check()).toMatchObject({ ok: false, code: 'limit_reached' })
    // The browser now says UTC+14: it is the 1st there, and a fresh 120 hours open.
    await h.app.accounts.setTimeZone(actor, 'Pacific/Kiritimati')
    expect(await check()).toMatchObject({ ok: false, code: 'limit_reached' })
  }, 60_000)
})

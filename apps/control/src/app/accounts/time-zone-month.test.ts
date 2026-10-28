// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A month is counted in one time zone from its start to its end: a zone the browser reports once
 * the account has played waits for the next month, so a month that is used up stays used up.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { nextMonthStart } from '../../domain/account/play-day.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

const PLUS_HOURS = entitlementsFor('plus').includedUnits ?? 0

describe.skipIf(!hasDatabase)('a time zone reported at the end of a used-up month', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('leaves the month used up until it ends', async () => {
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
    // A zone reported once the account has played waits for the next month: this one stays UTC's.
    await h.app.accounts.setTimeZone(actor, 'Pacific/Kiritimati')
    expect(await check()).toMatchObject({ ok: false, code: 'limit_reached' })
  }, 60_000)

  test('the time zone is the browser’s, and one Cubepals doesn’t know leaves it as it was', async () => {
    const actor = await h.user('Remy', 'plus')
    expect((await h.app.accountQueries.me(actor)).timeZone).toBeNull()
    await h.app.accounts.setTimeZone(actor, 'Mars/Olympus')
    expect((await h.app.accountQueries.me(actor)).timeZone).toBeNull()
    await h.app.accounts.setTimeZone(actor, 'Europe/Paris')
    expect((await h.app.accountQueries.me(actor)).timeZone).toBe('Europe/Paris')
  }, 30_000)
})

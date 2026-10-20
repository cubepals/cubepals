// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `signals` job (`signals.ts`) on a real database, with a setting of the tests' own: nothing
 * without one, each signal raised once, the kinds that read wakes, the platform's hour and boot
 * reports, and a signal open a day closed as expired.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { SignalsConfig } from '@blockly/contracts/join-records'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { installTuning, tuning } from '../tuning.ts'

describe.skipIf(!hasDatabase)('the signals job', () => {
  let h: Harness
  let serverId: string
  const deployed = tuning()
  const setting = (signals: unknown) => installTuning({ ...deployed, joins: { reporter: 'off', signals } })
  const now = new Date()
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const keys = async () => (await h.db.select().from(schema.signals)).map((s) => s.key).sort()

  beforeAll(async () => {
    h = await startHarness()
    serverId = (await h.create(await h.user(), { name: 'Signalled' })).id
    // A join slow from login to the world, a few minutes ago.
    await h.db.insert(schema.joins).values({
      id: randomUUID(),
      kind: 'join',
      serverId,
      address: 'signalled.play.test',
      connectedAt: ago(5 * MINUTE_MS),
      loginAt: ago(5 * MINUTE_MS),
      inWorldAt: ago(4 * MINUTE_MS),
      playerName: 'Steve',
    })
  }, 30_000)

  afterEach(async () => {
    installTuning(deployed)
    await h.db.delete(schema.signals)
  })

  afterAll(async () => {
    await h.close()
  })

  test('raises nothing with no setting, or one that is not the shape it should be', async () => {
    setting(undefined)
    expect(await h.app.joins.raiseSignals(now)).toBe(0)
    setting('{"slowJoin": ')
    expect(await h.app.joins.raiseSignals(now)).toBe(0)
    setting({ slowJoin: { loginToWorldS: -1 } })
    expect(await h.app.joins.raiseSignals(now)).toBe(0)
    expect(await keys()).toEqual([])
  })

  test('raises each signal once, with the server’s name, the figure and the limit', async () => {
    setting({ slowJoin: { loginToWorldS: 30 } } satisfies SignalsConfig)
    expect(await h.app.joins.raiseSignals(now)).toBe(1)
    expect(await h.app.joins.raiseSignals(now)).toBe(0)
    const [signal] = await h.db.select().from(schema.signals)
    expect(signal).toMatchObject({ kind: 'slow_join', serverId, closedAt: null })
    expect(signal?.detail).toMatchObject({ server: 'Signalled', player: 'Steve', figure: 60, limit: 30 })
  })

  test('wakes nobody joined, repeated wakes, a crowded hour and a login listener', async () => {
    for (let i = 0; i < 3; i++) {
      await h.db.insert(schema.powerIntervals).values({
        serverId,
        memoryTier: '2g',
        startedAt: ago((i + 2) * HOUR_MS),
        stoppedAt: ago((i + 1) * HOUR_MS),
        woken: true,
      })
      await h.db.insert(schema.serverOperations).values({
        id: randomUUID(),
        serverId,
        kind: 'start',
        status: 'succeeded',
        requestedBy: 'system:wake',
        idempotencyKey: `test-wake:${i}`,
        createdAt: ago((i + 1) * 10 * MINUTE_MS),
      })
    }
    // One join this hour on each of the seven days before, and four in the last hour.
    const joinAt = (when: Date) => ({
      id: randomUUID(),
      kind: 'join' as const,
      serverId,
      address: 'x.play.test',
      connectedAt: when,
    })
    await h.db
      .insert(schema.joins)
      .values([
        ...[1, 2, 3, 4, 5, 6, 7].map((d) => joinAt(ago(d * DAY_MS + 10 * MINUTE_MS))),
        ...[1, 2, 3, 4].map((m) => joinAt(ago(m * MINUTE_MS + SECOND_MS))),
      ])
    await h.db
      .insert(schema.serverReports)
      .values({ serverId, reportedAt: ago(HOUR_MS), detail: { loginListeners: ['OldAuth'] } })
    setting({
      wakeNoJoin: { perServerPerDay: 3 },
      repeatedWakes: { perServerPerHour: 3 },
      crowd: { platformHourOverAverage: 2 },
      legacyLoginListener: {},
    } satisfies SignalsConfig)
    expect(await h.app.joins.raiseSignals(now)).toBe(4)
    const kinds = (await h.db.select().from(schema.signals)).map((s) => s.kind).sort()
    expect(kinds).toEqual(['crowd', 'legacy_login_listener', 'repeated_wakes', 'wake_no_join'])
  })

  test('closes a signal open a day as expired, whatever the setting', async () => {
    setting(undefined)
    await h.db.insert(schema.signals).values({ kind: 'short_stay', key: 'old', at: ago(DAY_MS + MINUTE_MS) })
    await h.db.insert(schema.signals).values({ kind: 'short_stay', key: 'new', at: ago(MINUTE_MS) })
    await h.app.joins.raiseSignals(now)
    const [old] = await h.db.select().from(schema.signals).where(eq(schema.signals.key, 'old'))
    const [fresh] = await h.db.select().from(schema.signals).where(eq(schema.signals.key, 'new'))
    expect(old).toMatchObject({ closedBy: 'system:expired', closedAt: now })
    expect(fresh?.closedAt).toBeNull()
  })
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `signals` job (`signals.ts`) on a real database, with a setting of the tests' own: nothing
 * without one, each signal raised once, the kinds that read wakes, the platform's hour and boot
 * reports, a drop keeping what the provider's proxy said around it, and a signal open a day closed
 * as expired.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { SignalsConfig } from '@blockly/contracts/join-records'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { LogLine, Mailer } from '../ports/platform.ts'
import { installTuning, tuning } from '../tuning.ts'
import { tellSignals, type Written } from './signal-mail.ts'
import { raiseSignals } from './signals.ts'

/** A nine-hour session that ended a minute before `now` with its player cut off, as the edge tells of one. */
async function longSession(h: Harness, serverId: string, now: Date): Promise<string> {
  const id = randomUUID()
  const session = {
    closedFirst: 'server',
    how: 'closed',
    quietAtEndMs: 24_000,
    downQuietAtEndMs: 1,
    stalls: 2,
  }
  await h.db.insert(schema.joins).values({
    id,
    kind: 'join',
    serverId,
    address: 'signalled.play.test',
    playerName: 'Alex',
    connectedAt: new Date(now.getTime() - 9 * HOUR_MS),
    handedAt: new Date(now.getTime() - 9 * HOUR_MS + MINUTE_MS),
    leftAt: new Date(now.getTime() - MINUTE_MS),
    detail: { session },
  })
  return id
}

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

  test('a session longer than the hours read is judged once it ends', async () => {
    setting({ dropped: { quietS: 5 } })
    const id = await longSession(h, serverId, now)
    expect(await h.app.joins.raiseSignals(now)).toBe(1)
    expect(await keys()).toEqual([`dropped:${id}`])
    // Said once: the next pass raises nothing new.
    expect(await h.app.joins.raiseSignals(now)).toBe(0)
    await h.db.delete(schema.joins).where(eq(schema.joins.id, id))
  }, 30_000)

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

describe.skipIf(!hasDatabase)('a drop and the provider’s proxy', () => {
  let h: Harness
  let serverId: string
  const deployed = tuning()
  const setting = (signals: unknown) => installTuning({ ...deployed, joins: { reporter: 'off', signals } })
  const now = new Date()

  beforeAll(async () => {
    h = await startHarness()
    serverId = (await h.create(await h.user(), { name: 'Signalled' })).id
    await h.until(serverId, 'running')
  }, 30_000)

  afterEach(async () => {
    installTuning(deployed)
    await h.db.delete(schema.signals)
  })

  afterAll(async () => {
    await h.close()
  })

  test('a drop keeps what the provider’s proxy said around it, asked once, and its email says it', async () => {
    setting({ dropped: { quietS: 5 }, notify: ['dropped'] })
    const id = await longSession(h, serverId, now)
    const asked: Date[][] = []
    const said: LogLine = {
      at: new Date(now.getTime() - MINUTE_MS + 4 * SECOND_MS),
      text: '[PP03] could not proxy TCP data to/from instance for 203.0.113.7:52555 (tcp-backhaul: connection reset)',
    }
    const logs = {
      edgeSaid: async (_handle: unknown, from: Date, to: Date) => {
        asked.push([from, to])
        return [said]
      },
    }
    const sent: string[] = []
    const mailer: Mailer = { send: async (message) => void sent.push(message.text) }
    const tell = (config: SignalsConfig, written: Written[]) =>
      tellSignals(
        { db: h.db, mailer, inbox: ['ops@blockly.test'], origin: 'https://blockly.test' },
        config.notify,
        written,
      )
    expect(await raiseSignals(h.db, now, tell, logs)).toBe(1)
    const kept = [{ at: said.at.toISOString(), said: said.text.replace('203.0.113.7', '<address>') }]
    const [signal] = await h.db
      .select()
      .from(schema.signals)
      .where(eq(schema.signals.key, `dropped:${id}`))
    expect(signal?.detail.provider).toEqual(kept)
    // Read around the session's end, a minute before now.
    expect(asked).toHaveLength(1)
    expect(asked[0]?.[1]).toEqual(new Date(now.getTime() - MINUTE_MS + 30 * SECOND_MS))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('the provider’s proxy said: [PP03] could not proxy TCP data')
    expect(sent[0]).not.toContain('203.0.113.7')
    // Raised once, so asked once.
    expect(await raiseSignals(h.db, now, tell, logs)).toBe(0)
    expect(asked).toHaveLength(1)
    await h.db.delete(schema.joins).where(eq(schema.joins.id, id))
  }, 60_000)

  test('a drop is raised as the edge told it where the provider’s proxy can’t be read, or there is none', async () => {
    setting({ dropped: { quietS: 5 } })
    const id = await longSession(h, serverId, now)
    const failing = {
      edgeSaid: async (): Promise<LogLine[]> => {
        throw new Error('Fly: reading logs failed with 503')
      },
    }
    expect(await raiseSignals(h.db, now, undefined, failing)).toBe(1)
    const [unread] = await h.db
      .select()
      .from(schema.signals)
      .where(eq(schema.signals.key, `dropped:${id}`))
    expect(unread?.detail).toMatchObject({ why: 'player_silent' })
    expect(unread?.detail.provider).toBeUndefined()
    await h.db.delete(schema.signals)
    // A provider with no proxy in front of the edge says null: nothing is kept, not an empty list.
    expect(await raiseSignals(h.db, now, undefined, { edgeSaid: async () => null })).toBe(1)
    const [none] = await h.db
      .select()
      .from(schema.signals)
      .where(eq(schema.signals.key, `dropped:${id}`))
    expect(none?.detail.provider).toBeUndefined()
    await h.db.delete(schema.joins).where(eq(schema.joins.id, id))
  }, 60_000)
})

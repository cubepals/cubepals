// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How servers tick, kept and read back on a real database: a sample kept once however often it
 * is sent, one from long ago or the future not at all, one server's samples and what they add up
 * to, the servers that ticked worst with whose they are, an account's alone, and the sweep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DAY_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { LAGGING_TPS, type ServerVitals } from '@blockly/contracts/server-vitals'
import { MemoryLimits } from '../../infra/limits/memory-limits.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { installTuning, tuning } from '../tuning.ts'
import { VITALS_KEPT_DAYS, VitalsService } from './service.ts'

const now = new Date('2026-11-04T12:00:00.000Z')
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

/** A minute's sample, keeping up unless told otherwise. */
const sample = (at: string, fields: Partial<ServerVitals> = {}): ServerVitals => ({
  at,
  tps: 20,
  mspt: 12,
  msptP95: 20,
  msptMax: 30,
  players: 2,
  chunks: 900,
  entities: 300,
  heapUsedMb: 1000,
  heapMaxMb: 2000,
  gcMs: 10,
  ...fields,
})

describe.skipIf(!hasDatabase)('how servers tick', () => {
  let h: Harness
  let vitals: VitalsService
  let smooth: string
  let laggy: string
  let laggyOwner: string

  beforeAll(async () => {
    h = await startHarness()
    vitals = new VitalsService({ db: h.db, limits: new MemoryLimits() })
    smooth = (await h.create(await h.user('Smooth'), { name: 'Smooth' })).id
    const owner = await h.user('Laggy')
    laggyOwner = owner.userId
    laggy = (await h.create(owner, { name: 'Laggy' })).id
    await vitals.record(smooth, [sample(ago(3 * MINUTE_MS)), sample(ago(2 * MINUTE_MS))], now)
    await vitals.record(
      laggy,
      [
        sample(ago(3 * MINUTE_MS), { tps: 12, mspt: 80, msptP95: 140, msptMax: 400, heapUsedMb: 1900 }),
        sample(ago(2 * MINUTE_MS), { tps: LAGGING_TPS + 1, mspt: 45, msptP95: 70, msptMax: 90, gcMs: 800 }),
      ],
      now,
    )
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('keeps a sample once, and none from an hour ago or from ahead of now', async () => {
    expect(await vitals.record(smooth, [sample(ago(2 * MINUTE_MS))], now)).toBe(0)
    expect(
      await vitals.record(smooth, [sample(ago(61 * MINUTE_MS)), sample(ago(-10 * MINUTE_MS))], now),
    ).toBe(0)
    expect(await vitals.record(smooth, [sample(ago(MINUTE_MS))], now)).toBe(1)
  })

  test('one server’s samples, oldest first, with the newest and what they add up to', async () => {
    const view = await vitals.ofServer(laggy, new Date(ago(10 * MINUTE_MS)), now)
    expect(view.serverName).toBe('Laggy')
    expect(view.samples.map((s) => s.tps)).toEqual([12, LAGGING_TPS + 1])
    expect(view.latest?.at).toBe(ago(2 * MINUTE_MS))
    expect(view.summary).toMatchObject({
      samples: 2,
      tpsMin: 12,
      msptMax: 400,
      laggingMinutes: 1,
      heapShareMax: 0.95,
      gcMsMax: 800,
    })
    const none = await vitals.ofServer(laggy, new Date(now.getTime() + MINUTE_MS), now)
    expect(none).toMatchObject({ latest: null, summary: null, samples: [] })
  })

  test('the servers that ticked worst first, with whose they are, or an account’s alone', async () => {
    const list = await vitals.worst({ since: new Date(ago(10 * MINUTE_MS)) })
    expect(list.servers.map((s) => [s.serverName, s.laggingMinutes])).toEqual([
      ['Laggy', 1],
      ['Smooth', 0],
    ])
    expect(list.servers[0]?.ownerEmail).toContain('@')
    const theirs = await vitals.worst({ since: new Date(ago(10 * MINUTE_MS)), ownerId: laggyOwner })
    expect(theirs.servers.map((s) => s.serverId)).toEqual([laggy])
  })

  test('the sweep forgets samples past their days', async () => {
    const old = new Date(now.getTime() - (VITALS_KEPT_DAYS + 1) * DAY_MS)
    // As the sweep finds it then: kept when it was fresh.
    await vitals.record(smooth, [sample(old.toISOString())], old)
    expect(await vitals.sweep(now)).toBe(1)
    expect(await vitals.sweep(now)).toBe(0)
  })

  test('a server may post a few times a minute, and no more', async () => {
    const at = new Date('2026-11-04T13:00:30.000Z')
    const allowed = tuning().abuse.vitalsReportsPerMinute
    const answers = await Promise.all(Array.from({ length: allowed + 2 }, () => vitals.mayReport(smooth, at)))
    expect(answers.filter(Boolean)).toHaveLength(allowed)
    expect(await vitals.mayReport(smooth, new Date(at.getTime() + MINUTE_MS))).toBe(true)
  })

  test('how often is the deployment’s own, from ABUSE_LIMITS', async () => {
    const deployed = tuning()
    installTuning({ ...deployed, abuse: { ...deployed.abuse, vitalsReportsPerMinute: 1 } })
    try {
      const at = new Date('2026-11-04T14:00:30.000Z')
      expect([await vitals.mayReport(smooth, at), await vitals.mayReport(smooth, at)]).toEqual([true, false])
    } finally {
      installTuning(deployed)
    }
  })
})

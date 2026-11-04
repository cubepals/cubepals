// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How every server's ticks are read, on a real database: the pass that reads who is on asks a
 * server's console `tick query` too and keeps what it says, unless the reporter plugin has just
 * sampled that server; a frozen or sprinting game isn't kept; and the platform now counts the
 * running servers, how many were sampled and from where, how many are behind and how many said
 * nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { MemoryLimits } from '../../infra/limits/memory-limits.ts'
import { TICK_QUERY } from '../../minecraft/console.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { recordConsoleTick, reportingServers, ticksPerSecond } from './console-samples.ts'
import { VitalsService } from './service.ts'

const reading = {
  state: 'running' as const,
  targetTps: 20,
  msptMean: 0.2,
  msptP50: 0.2,
  msptP95: 0.3,
  msptP99: 1.6,
}

describe('ticks a second from a console reading', () => {
  test('the target while the server keeps up, fewer when a tick takes longer than it gives', () => {
    expect(ticksPerSecond(reading)).toBe(20)
    expect(ticksPerSecond({ ...reading, state: 'lagging', msptMean: 80 })).toBe(12.5)
    expect(ticksPerSecond({ ...reading, msptMean: 0 })).toBe(20)
  })
})

describe.skipIf(!hasDatabase)('every server’s ticks', () => {
  let h: Harness
  let vitals: VitalsService

  const running = async (name: string) => {
    const owner = await h.user(name)
    const server = await h.create(owner, { name })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return { owner, id: server.id }
  }
  const consoleRows = (serverId: string) =>
    h.db
      .select()
      .from(schema.serverVitals)
      .where(and(eq(schema.serverVitals.serverId, serverId), eq(schema.serverVitals.source, 'console')))

  beforeAll(async () => {
    h = await startHarness()
    vitals = new VitalsService({ db: h.db, limits: new MemoryLimits() })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('the pass that reads who is on reads how a server ticks, and keeps it as its console said', async () => {
    const { id } = await running('Console')
    await h.app.schedules.presenceSync()
    const [row] = await consoleRows(id)
    expect(row).toMatchObject({
      source: 'console',
      tps: 20,
      mspt: 0.2,
      msptP95: 0.3,
      msptMax: 1.6,
      players: 0,
      chunks: null,
      entities: null,
      heapUsedMb: null,
      heapMaxMb: null,
      gcMs: null,
    })
    expect(h.minecraft.heard(id)).toContain(TICK_QUERY)
  }, 30_000)

  test('a server the reporter plugin just sampled is the plugin’s, and its console isn’t asked', async () => {
    const { id } = await running('Reported')
    const now = new Date()
    const sample = {
      at: new Date(now.getTime() - MINUTE_MS).toISOString(),
      tps: 20,
      mspt: 10,
      msptP95: 15,
      msptMax: 30,
      players: 1,
      chunks: 400,
      entities: 90,
      heapUsedMb: 900,
      heapMaxMb: 2048,
      gcMs: 4,
    }
    expect(await vitals.record(id, [sample], now)).toBe(1)
    expect(await reportingServers(h.db, [id], now)).toEqual(new Set([id]))
    await h.app.schedules.presenceSync()
    expect(await consoleRows(id)).toEqual([])
    expect(h.minecraft.heard(id)).not.toContain(TICK_QUERY)
    // Once the plugin has been quiet a while, the console is read instead.
    expect(await reportingServers(h.db, [id], new Date(now.getTime() + 5 * MINUTE_MS))).toEqual(new Set())
  }, 30_000)

  test('a frozen or sprinting game is an operator’s doing, and isn’t kept', async () => {
    const { id } = await running('Frozen')
    expect(await recordConsoleTick(h.db, id, { ...reading, state: 'frozen' }, 0)).toBe(false)
    expect(await recordConsoleTick(h.db, id, { ...reading, state: 'sprinting' }, 0)).toBe(false)
    expect(await consoleRows(id)).toEqual([])
  }, 30_000)

  test('the platform now: running, sampled and from where, behind, and silent', async () => {
    const { id: behind, owner } = await running('Behind')
    await recordConsoleTick(h.db, behind, { ...reading, state: 'lagging', msptMean: 80 }, 3)
    const { platform } = await vitals.worst({ since: new Date(Date.now() - 10 * MINUTE_MS) })
    expect(platform.byReporter).toBeGreaterThanOrEqual(1)
    expect(platform.byConsole).toBeGreaterThanOrEqual(2)
    expect(platform.laggingNow).toBeGreaterThanOrEqual(1)
    expect(platform.sampled).toBe(platform.byReporter + platform.byConsole)
    expect(platform.silent).toBe(platform.running - platform.sampled)
    // Narrowed to one account: its one server, behind.
    const theirs = await vitals.worst({ since: new Date(Date.now() - 10 * MINUTE_MS), ownerId: owner.userId })
    expect(theirs.platform).toMatchObject({ running: 1, sampled: 1, byConsole: 1, laggingNow: 1, silent: 0 })
    const [row] = theirs.servers
    expect(row).toMatchObject({ serverId: behind, sources: ['console'], heapShareMax: null, chunksMax: null })
  }, 30_000)
})

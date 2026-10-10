// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The spend watchdog (docs/money-guards.md), against a real database: the day's figure from
 * recorded play, the trip past the limit and only past it, what the trip stops (the edge's
 * wake-on-join included), an admin's say over it, and compute that runs with no running server
 * behind it. The arithmetic alone is `domain/policy/spend.test.ts`'s.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { EDGE_PROTOCOL_BASE } from '@blockly/contracts/edge'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { createInternalApp } from '../../interfaces/edge/internal.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadControls } from '../accounts/persistence.ts'
import type { Actor, UserActor } from '../actor.ts'
import { loadSpendDay } from '../platform/persistence.ts'
import type { RuntimeKey } from '../ports/runtime.ts'
import { loadRuntime } from '../servers/persistence.ts'

/** Noon, UTC, on a January day of 2020: before anything the harness runs, so only what a test records counts. */
const noon = (day: number) => new Date(`2020-01-${String(day).padStart(2, '0')}T12:00:00Z`)
const midnight = (day: number) => new Date(`2020-01-${String(day).padStart(2, '0')}T00:00:00Z`)
const HOUR = 3_600_000

let h: Harness
let admin: Extract<Actor, { kind: 'admin' }>
let adminEmail: string
let owner: UserActor
let server: { id: string; slug: string }

// One harness for the file: each describe goes on from what the one before it left.
beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness()
  const person = await h.user('Admin')
  await h.db.insert(schema.platformAdmins).values({ userId: person.userId, grantedBy: 'test' })
  admin = { kind: 'admin', userId: person.userId }
  adminEmail = `${person.userId}@example.test`
  owner = await h.user()
  const created = await h.create(owner)
  await h.until(created.id, 'running')
  await h.settled(created.id)
  await h.app.servers.stop(owner, created.id, randomUUID(), 'idle')
  await h.until(created.id, 'stopped')
  await h.settled(created.id)
  server = { id: created.id, slug: created.slug }
}, 30_000)

afterAll(async () => {
  if (hasDatabase) await h.close()
})

/** A run recorded on the test's server, as a start and a stop would have written it. */
const ran = (tier: string, startedAt: Date, stoppedAt: Date | null) =>
  h.db.insert(schema.powerIntervals).values({ serverId: server.id, memoryTier: tier, startedAt, stoppedAt })
const limit = (cents: number) => h.db.update(schema.platformControls).set({ dailySpendLimitCents: cents })
const switchesOn = () =>
  h.db.update(schema.platformControls).set({ startsEnabled: true, provisioningEnabled: true })
const audit = (action: string) =>
  h.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action))
const mailed = () => h.mail.to(adminEmail).filter((m) => m.subject.includes('daily limit'))
const quietly = <T>(work: () => Promise<T>) => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  return work().finally(() => warn.mockRestore())
}

describe.skipIf(!hasDatabase)('spend watchdog: the day’s figure, and the trip past its limit', () => {
  test('a day under its limit is written down, and nothing is paused', async () => {
    await limit(1000)
    // Ten hours on the large size: $2.12.
    await ran('8g', midnight(1), new Date(midnight(1).getTime() + 10 * HOUR))
    const day = await h.app.schedules.spendCheck(noon(1))
    expect(day).toMatchObject({ day: '2020-01-01', computeCents: 212, strayCents: 0, tripped: false })
    expect(day.cents).toBeLessThanOrEqual(1000)
    expect(await loadSpendDay(h.db, '2020-01-01')).toMatchObject({ computeCents: 212, trippedAt: null })
    expect(await loadControls(h.db)).toMatchObject({ startsEnabled: true, provisioningEnabled: true })
    expect(await audit('platform.spend_limit_reached')).toEqual([])
    expect(mailed()).toEqual([])
  })

  test('at the limit nothing trips; a cent past it pauses starts and creation, as the system, and admins hear once', async () => {
    // A run still open since midnight on the default size: twelve hours by noon.
    await ran('3g', midnight(2), null)
    await limit(100_000)
    const { cents } = await h.app.schedules.spendCheck(noon(2))
    expect(cents).toBeGreaterThanOrEqual(75)

    await limit(cents)
    expect((await h.app.schedules.spendCheck(noon(2))).tripped).toBe(false)
    expect(await loadControls(h.db)).toMatchObject({ startsEnabled: true, provisioningEnabled: true })

    await limit(cents - 1)
    expect((await h.app.schedules.spendCheck(noon(2))).tripped).toBe(true)
    expect(await loadControls(h.db)).toMatchObject({
      startsEnabled: false,
      provisioningEnabled: false,
      updatedBy: 'system:spend',
    })
    expect(await audit('platform.controls_changed')).toMatchObject([
      {
        actor: 'system:spend',
        data: { startsEnabled: { from: true, to: false }, provisioningEnabled: { from: true, to: false } },
      },
    ])
    expect(await audit('platform.spend_limit_reached')).toMatchObject([
      { actor: 'system:spend', data: { day: '2020-01-02', cents, limitCents: cents - 1 } },
    ])
    expect(mailed()).toHaveLength(1)
    expect(mailed()[0]?.text).toContain('/admin/platform')
    expect(mailed()[0]?.html).toContain('<img src="http://localhost:3000/email/lockup.png"')

    // Another pass the same day: no second trip, audit or email.
    expect((await h.app.schedules.spendCheck(noon(2))).tripped).toBe(false)
    expect(await audit('platform.spend_limit_reached')).toHaveLength(1)
    expect(mailed()).toHaveLength(1)
    await h.db
      .update(schema.powerIntervals)
      .set({ stoppedAt: noon(2) })
      .where(
        and(eq(schema.powerIntervals.serverId, server.id), eq(schema.powerIntervals.startedAt, midnight(2))),
      )
  })
})

describe.skipIf(!hasDatabase)('spend watchdog: what the trip stops, and an admin’s say over it', () => {
  test('paused by the watchdog, nothing starts: not the Start button, not a player joining through the edge', async () => {
    expect(await loadControls(h.db)).toMatchObject({ startsEnabled: false, provisioningEnabled: false })
    const edge = createInternalApp({ edge: h.app.edge, token: 'edge-token' })
    const wake = await edge.request(`${EDGE_PROTOCOL_BASE}/wake`, {
      method: 'POST',
      headers: { authorization: 'Bearer edge-token', 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: `${server.slug}.play.test` }),
    })
    expect(await wake.json()).toEqual({ outcome: 'denied', reason: 'paused' })
    await expect(h.app.servers.start(owner, server.id, randomUUID())).rejects.toMatchObject({
      code: 'platform_paused',
    })
    await expect(h.create(await h.user())).rejects.toMatchObject({ code: 'platform_paused' })
    expect((await h.server(server.id)).lifecycle.status).toBe('stopped')
  })

  test('an admin who turns them back on that day is not overruled until the next', async () => {
    const view = await h.app.platform.view(admin)
    await h.app.platform.set(admin, {
      provisioningEnabled: true,
      startsEnabled: true,
      publicListingEnabled: view.publicListingEnabled,
      uploadsEnabled: view.uploadsEnabled,
      storingEnabled: view.storingEnabled,
      expiringEnabled: view.expiringEnabled,
      maxServers: view.maxServers,
      maxRunningServers: view.maxRunningServers,
      maxFreeAccounts: view.maxFreeAccounts,
      dailySpendLimitCents: view.dailySpendLimitCents,
    })
    expect((await h.app.schedules.spendCheck(noon(2))).tripped).toBe(false)
    expect(await loadControls(h.db)).toMatchObject({ startsEnabled: true, provisioningEnabled: true })

    // The next day over its limit trips again, and says so again.
    await ran('8g', midnight(3), new Date(midnight(3).getTime() + 10 * HOUR))
    await limit(100)
    expect((await h.app.schedules.spendCheck(noon(3))).tripped).toBe(true)
    expect(await loadControls(h.db)).toMatchObject({ startsEnabled: false, provisioningEnabled: false })
    expect(mailed()).toHaveLength(2)
    await switchesOn()
    await limit(1000)
  })
})

describe.skipIf(!hasDatabase)('spend watchdog: compute nobody accounts for, and the admin page', () => {
  test('a machine Fly runs behind a server the control plane thinks is stopped is counted, priced, and stopped', async () => {
    await limit(100_000)
    const { handle } = await loadRuntime(h.db, server.id, ['fake'])
    if (handle === null) throw new Error('no handle')
    const unknown = randomUUID()
    // The provider's clock held at the start of a January day, so the stray compute is priced on
    // that day and never on the one after the real clock, whatever time the suite runs.
    setSystemTime(midnight(4))
    try {
      // Started at the provider, not through Cubepals.
      await h.runtime.start(handle)
      expect(h.runtime.machine(server.id)?.state).toBe('running')
      // And compute for a server this database doesn't know, as after restoring an older backup.
      await h.runtime.ensureProvisioned(
        unknown as RuntimeKey,
        { regionKey: 'local' },
        h.runtime.machine(server.id)?.spec ?? (null as never),
        { step: async () => {}, handle: async () => {} },
      )
    } finally {
      setSystemTime()
    }

    const seen = await h.app.schedules.spendCheck(noon(4))
    expect(seen.day).toBe('2020-01-04')
    expect(seen.strayMachines).toBe(2)
    expect(seen.strayCents).toBeGreaterThan(0)
    expect((await h.server(server.id)).lifecycle.status).toBe('stopped')

    await quietly(() => h.app.schedules.orphans())
    expect(h.runtime.machine(server.id)?.state).toBe('stopped')
    // Stopped, never destroyed: its world is there for an operator.
    expect(h.runtime.machine(unknown)?.state).toBe('stopped')
    const stopped = await h.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'server.stray_compute_stopped'),
          eq(schema.auditLog.actor, 'system:orphans'),
        ),
      )
    expect(stopped.map((row) => row.subjectId).sort()).toEqual([server.id, unknown].sort())
    expect((await h.app.schedules.spendCheck()).strayMachines).toBe(0)
    await h.runtime.destroy(unknown as RuntimeKey)
  })

  test('the admin page shows the latest day’s figure', async () => {
    const day = await h.app.schedules.spendCheck()
    const { spend, dailySpendLimitCents } = await h.app.platform.view(admin)
    expect(dailySpendLimitCents).toBe(100_000)
    expect(spend).toMatchObject({ day: day.day, cents: day.cents, strayMachines: 0, trippedAt: null })
  })
})

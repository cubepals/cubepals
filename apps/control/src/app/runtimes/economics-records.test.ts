// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Synthetic ledger records exercise report arithmetic without running unrelated runtime scenarios. */
import { afterEach, describe, expect, test } from 'bun:test'
import { HOUR_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { memoryMb } from '../../domain/server/size.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { installTuning, tuning } from '../tuning.ts'
import { type EconomicsReport, RuntimeEconomics } from './economics.ts'
import { RuntimeRouter } from './router.ts'

const installed = tuning()
afterEach(() => installTuning(installed))
const from = new Date('2025-01-01T00:00:00Z')
const at = (hours: number) => new Date(from.getTime() + hours * HOUR_MS)
const window = { from, to: at(12) }
// Arbitrary fixture prices make an hour of the synthetic machine and archive easy to verify.
const monthly = 730
const gb = 1024 ** 3
function figures() {
  installTuning({
    ...installed,
    economics: {
      paymentFee: { percent: 10, fixedCents: 7 },
      archiveGbMonthCents: monthly,
    },
  })
}
async function stopped(h: Harness, owner: Awaited<ReturnType<Harness['user']>>) {
  const server = await h.create(owner)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  await h.app.servers.stop(owner, server.id, crypto.randomUUID())
  await h.until(server.id, 'stopped')
  await h.settled(server.id)
  return server
}
async function order(h: Harness, userId: string, netCents = 1200, orderedAt = at(3), refundedCents = 200) {
  await h.db.insert(schema.billingOrders).values({
    provider: 'polar',
    externalOrderId: crypto.randomUUID(),
    userId,
    planKey: 'plus',
    billingReason: 'subscription_cycle',
    currency: 'usd',
    subtotalCents: netCents,
    discountCents: 0,
    netCents,
    taxCents: 300,
    totalCents: netCents + 300,
    refundedCents,
    orderedAt,
  })
}
async function ledgerHarness() {
  return startHarness({
    runtimePrices: { runningHourCents: 3, storageMonthCents: 0 },
    otherRuntimes: [
      {
        provider: 'measured',
        prices: { runningHourCents: 0, storageMonthCents: 0 },
        capacity: {
          machines: [
            {
              name: 'measured-one',
              region: 'local',
              state: 'active',
              monthlyCents: monthly,
              allocatableMemoryMb: 4096,
              allocatedMemoryMb: 1024,
              placedMemoryMb: 1536,
              usedMemoryMb: 2048,
              cpus: 2,
              allocatedCpuMillis: 2000,
              usedCpuCores: 1,
              servers: 1,
            },
            {
              name: 'unknown-size',
              region: 'local',
              state: 'active',
              monthlyCents: null,
              allocatableMemoryMb: 0,
              allocatedMemoryMb: 0,
              placedMemoryMb: 0,
              usedMemoryMb: null,
              cpus: 0,
              allocatedCpuMillis: 0,
              usedCpuCores: null,
              servers: 0,
            },
          ],
        },
      },
    ],
  })
}

async function seedLedger(h: Harness) {
  const owner = await h.user('Ledger', 'plus')
  const first = await stopped(h, owner)
  await h.app.placement.addRule({ provider: 'measured', percent: 100 }, 'operator:fixture')
  const second = await stopped(h, owner)
  await h.db.insert(schema.powerIntervals).values([
    {
      serverId: first.id,
      memoryTier: first.memoryTier,
      provider: 'fake',
      startedAt: at(-1),
      stoppedAt: at(4),
    },
    {
      serverId: first.id,
      memoryTier: first.memoryTier,
      provider: 'retired',
      startedAt: at(4),
      stoppedAt: at(7),
    },
    { serverId: second.id, memoryTier: 'legacy-size', provider: null, startedAt: at(0), stoppedAt: null },
  ])
  await h.db.insert(schema.serverUsageDays).values([
    {
      serverId: first.id,
      day: '2025-01-01',
      provider: 'fake',
      activeMinutes: 120,
      playerMinutes: 300,
      peakPlayers: 4,
      lastSampleAt: at(3),
    },
    {
      serverId: second.id,
      day: '2025-01-01',
      provider: 'measured',
      activeMinutes: 60,
      playerMinutes: 120,
      peakPlayers: 2,
      lastSampleAt: at(3),
    },
    {
      serverId: first.id,
      day: '2025-01-02',
      provider: 'fake',
      activeMinutes: 900,
      playerMinutes: 900,
      peakPlayers: 90,
      lastSampleAt: at(25),
    },
  ])
  await h.db
    .update(schema.serverRuntimes)
    .set({ diskUsedBytes: gb })
    .where(eq(schema.serverRuntimes.serverId, first.id))
  await h.db
    .update(schema.serverRuntimes)
    .set({ diskUsedBytes: null })
    .where(eq(schema.serverRuntimes.serverId, second.id))
  const [world] = await h.db.select().from(schema.worlds).where(eq(schema.worlds.serverId, first.id))
  if (!world) throw new Error('The created server must retain its world')
  await h.db.insert(schema.backups).values([
    {
      serverId: first.id,
      worldId: world.id,
      revisionId: first.desiredRevisionId,
      tier: 'archive',
      trigger: 'manual',
      status: 'ready',
      sizeBytes: 2 * gb,
    },
    {
      serverId: first.id,
      worldId: world.id,
      revisionId: first.desiredRevisionId,
      tier: 'archive',
      trigger: 'manual',
      status: 'failed',
      sizeBytes: 99 * gb,
    },
  ])
  await order(h, owner.userId)
  const nobody = await h.user()
  await order(h, nobody.userId, 200, at(2), 0)
  await order(h, owner.userId, 9000, at(7), 0)
  return { first, second }
}

function assertServers(report: EconomicsReport, first: MinecraftServer, second: MinecraftServer) {
  const servers = new Map(report.servers.map((s) => [s.serverId, s]))
  const sizeGb = memoryMb(first.memoryTier) / 1024
  expect(servers.get(first.id)).toMatchObject({
    provider: 'fake',
    plan: 'plus',
    size: first.memoryTier,
    memoryMb: memoryMb(first.memoryTier),
    runningHours: 6,
    gbHours: 6 * sizeGb,
    activeHours: 2,
    playerHours: 5,
    peakPlayers: 4,
    diskUsedGb: 1,
    backupGb: 2,
    unpricedHours: 2,
    infraCents: 12,
    revenueCents: 500,
    feeCents: 78.5,
    marginCents: 397.5,
    storageGb: entitlementsFor('plus').storage.startGb,
  })
  expect(servers.get(second.id)).toMatchObject({
    provider: 'measured',
    runningHours: 6,
    activeHours: 1,
    playerHours: 2,
    peakPlayers: 2,
    diskUsedGb: null,
    backupGb: 0,
    unpricedHours: 0,
    infraCents: 0,
    revenueCents: 500,
    feeCents: 78.5,
    marginCents: 421.5,
  })
}

function assertRuntimes(report: EconomicsReport, first: MinecraftServer, second: MinecraftServer) {
  const sizeGb = memoryMb(first.memoryTier) / 1024
  const runtimes = new Map(report.runtimes.map((r) => [r.provider, r]))
  expect([...runtimes.keys()]).toEqual(['fake', 'measured', 'retired'])
  expect(runtimes.get('fake')).toMatchObject({
    servers: 1,
    serversRan: 1,
    runningHours: 4,
    gbHours: 4 * sizeGb,
    activeHours: 2,
    playerHours: 5,
    backupGb: 2,
    usageCents: 12,
    capacityCents: 0,
    idleCents: 0,
    backupCents: 12,
    infraCents: 24,
    revenueCents: 500,
    feeCents: 78.5,
    marginCents: 397.5,
    marginPercent: 0.795,
    perServerCents: 24,
    perRunningHourCents: 6,
    perPlayedHourCents: 12,
    runningUtilization: null,
  })
  expect(runtimes.get('measured')).toMatchObject({
    servers: 1,
    serversRan: 1,
    runningHours: 6,
    activeHours: 1,
    playerHours: 2,
    usageCents: 0,
    capacityCents: 6,
    idleCents: 4.5,
    backupCents: 0,
    infraCents: 6,
    revenueCents: 500,
    feeCents: 78.5,
    marginCents: 415.5,
    marginPercent: 0.831,
    perServerCents: 6,
    perRunningHourCents: 1,
    perPlayedHourCents: 6,
    runningUtilization: memoryMb(second.memoryTier) / 4096,
  })
  expect(runtimes.get('measured')?.perAllocatedGbMonthCents).toBeCloseTo(monthly / sizeGb, 2)
  expect(runtimes.get('retired')).toMatchObject({
    servers: 0,
    serversRan: 1,
    runningHours: 2,
    gbHours: 2 * sizeGb,
    usageCents: 0,
    infraCents: 0,
    revenueCents: 0,
    marginPercent: null,
    perServerCents: null,
    perRunningHourCents: 0,
    perPlayedHourCents: null,
  })
  expect(report.machines).toEqual([
    expect.objectContaining({
      name: 'measured-one',
      provider: 'measured',
      utilization: 0.25,
      observedUtilization: 0.5,
      strandedMemoryMb: 3072,
      windowCents: 6,
    }),
    expect.objectContaining({
      name: 'unknown-size',
      utilization: null,
      observedUtilization: null,
      strandedMemoryMb: 0,
      windowCents: null,
    }),
  ])
}

function economics(h: Harness) {
  return new RuntimeEconomics({ db: h.db, runtimes: new RuntimeRouter([...h.runtimes.values()]) })
}

async function recorded() {
  figures()
  const h = await ledgerHarness()
  try {
    const { first, second } = await seedLedger(h)
    const report = await economics(h).report(window, 500, at(6))
    expect([report.from, report.to, report.hours]).toEqual([from.toISOString(), at(6).toISOString(), 6])
    expect(report.unattributedRevenueCents).toBe(200)
    assertServers(report, first, second)
    assertRuntimes(report, first, second)
  } finally {
    await h.close()
  }
}
async function equalShares() {
  figures()
  const h = await startHarness({ runtimePrices: { runningHourCents: 0, storageMonthCents: monthly } })
  try {
    const owner = await h.user('Ledger', 'plus')
    await stopped(h, owner)
    await stopped(h, owner)
    await order(h, owner.userId, 1200, at(2), 0)
    const full = await economics(h).report(window, 500, at(6))
    expect(full.servers).toHaveLength(2)
    for (const server of full.servers)
      expect(server).toMatchObject({
        runningHours: 0,
        gbHours: 0,
        revenueCents: 600,
        infraCents: 6,
      })
    expect(full.runtimes[0]).toMatchObject({
      servers: 2,
      serversRan: 0,
      revenueCents: 1200,
      usageCents: 12,
      perServerCents: 6,
      perRunningHourCents: null,
      perAllocatedGbMonthCents: null,
    })
    expect((await economics(h).report(window, 1, at(6))).servers).toHaveLength(1)
  } finally {
    await h.close()
  }
}
async function emptyWindow() {
  installTuning({ ...installed, economics: null })
  const h = await startHarness()
  try {
    const report = await economics(h).report(window, 500, at(-1))
    expect(report.hours).toBe(0)
    expect(report.to).toBe(report.from)
    expect(report.servers).toEqual([])
    expect(report.machines).toEqual([])
    expect(report.unattributedRevenueCents).toBe(0)
    expect(report.runtimes[0]).toMatchObject({
      servers: 0,
      serversRan: 0,
      runningHours: 0,
      capacityCents: 0,
      idleCents: 0,
      feeCents: null,
      marginCents: null,
      marginPercent: null,
      runningUtilization: null,
      perServerCents: null,
      perRunningHourCents: null,
      perPlayedHourCents: null,
      perAllocatedGbMonthCents: null,
    })
    expect(report.assumptions.paymentFee).toContain('not configured')
    expect(report.assumptions.backups).toContain('not configured')
  } finally {
    await h.close()
  }
}
describe.skipIf(!hasDatabase)('economics from recorded ledger inputs', () => {
  test(
    'prices recorded usage, capacity, backups and refunded orders in the bounded window',
    recorded,
    30 * SECOND_MS,
  )
  test(
    'owners with no running history share revenue equally and the report respects its limit',
    equalShares,
    30 * SECOND_MS,
  )
  test('a backwards empty window leaves unknown fees and ratios empty', emptyWindow, 30 * SECOND_MS)
})

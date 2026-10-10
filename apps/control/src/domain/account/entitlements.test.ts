import { describe, expect, test } from 'bun:test'
import {
  diskForWorld,
  entitlementsFor,
  grownDisk,
  longestSnapshotNeedDays,
  PAID_PLANS,
  planGap,
  planThatRuns,
  runsOn,
} from './entitlements.ts'
import { centsFor, isLarge, METER_UNITS, UNIT_CENTS, unitsFor } from './meter.ts'

describe('entitlements', () => {
  test('free is plain Minecraft on one small server, with no cap on a single run', () => {
    const free = entitlementsFor('free')
    expect(free).toMatchObject({
      maxServers: 1,
      maxRunning: 1,
      allowedMemoryTiers: ['3g'],
      includedUnits: 20,
      mayBuyMore: false,
      idleShutdownAfterMinutes: 10,
      playerIdleKickMinutes: 15,
      // The month's hours bound the cost; a countdown in chat would only add worry.
      maxSessionMinutes: null,
      allowedLoaders: ['vanilla', 'paper'],
      mayUseMods: false,
      mayUploadCustomMods: false,
      settingCaps: { maxPlayers: 5, viewDistance: 8, simulationDistance: 6 },
      worldRadius: 2500,
    })
    // Free's hours are a fraction of what any paid plan includes.
    for (const plan of PAID_PLANS) {
      expect(free.includedUnits ?? 0).toBeLessThan(entitlementsFor(plan).includedUnits ?? 0)
    }
  })

  test('plus runs everything, with 100 hours on sizes up to the large one', () => {
    const plus = entitlementsFor('plus')
    expect(plus).toMatchObject({
      maxServers: 3,
      maxRunning: 2,
      includedUnits: 100,
      // Extra hours, billed on the next payment, under extra-play.ts's guards.
      mayBuyMore: true,
      idleShutdownAfterMinutes: 15,
      // Every plan kicks idle players by default; never is the owner's own choice.
      playerIdleKickMinutes: 15,
      maxSessionMinutes: null,
      mayUseMods: true,
      mayUploadCustomMods: true,
      settingCaps: null,
      worldRadius: 10_000,
    })
    expect(plus.allowedLoaders).toEqual(['vanilla', 'paper', 'fabric', 'quilt', 'neoforge', 'forge'])
    // 6 GB ran on the 8 GB machine at the same cost, so it is no longer sold.
    expect(plus.allowedMemoryTiers).toEqual(['3g', '4g', '8g'])
    expect(PAID_PLANS).toEqual(['plus'])
  })

  test('the included block is 100 hours on the small sizes and 50 on the largest', () => {
    const included = entitlementsFor('plus').includedUnits ?? 0
    expect(included / METER_UNITS['3g']).toBe(100)
    expect(included / METER_UNITS['4g']).toBe(100)
    expect(included / METER_UNITS['8g']).toBe(50)
  })

  test('a size a plan sold before still runs on it; one it never sold does not', () => {
    const free = entitlementsFor('free')
    expect(runsOn(free, '3g')).toBe(true)
    // Servers made when free included 2 GB and 4 GB keep starting on them.
    expect(runsOn(free, '2g')).toBe(true)
    expect(runsOn(free, '4g')).toBe(true)
    expect(runsOn(free, '6g')).toBe(false)
    expect(runsOn(entitlementsFor('plus'), '2g')).toBe(true)
    expect(runsOn(entitlementsFor('plus'), '6g')).toBe(true)
  })

  test('one rule says whether a plan runs something, and which plan would', () => {
    const free = entitlementsFor('free')
    const plus = entitlementsFor('plus')
    const vanilla = { tier: '3g' as const, loader: 'vanilla' as const, modded: false }
    const pack = { tier: '4g' as const, loader: 'fabric' as const, modded: true }
    expect(planGap(free, vanilla, 'offered')).toBeNull()
    expect(planGap(free, { ...vanilla, loader: 'paper' }, 'offered')).toBeNull()
    // Paper with a plugin is not plain Minecraft any more.
    expect(planGap(free, { ...vanilla, loader: 'paper', modded: true }, 'offered')).toBe('mods')
    expect(planGap(free, { ...vanilla, loader: 'fabric' }, 'offered')).toBe('server_type')
    expect(planGap(free, pack, 'offered')).toBe('mods')
    expect(planGap(free, { ...vanilla, tier: '4g' }, 'offered')).toBe('size')
    expect(planGap(free, { ...vanilla, tier: '4g' }, 'startable')).toBeNull()
    expect(planGap(plus, pack, 'offered')).toBeNull()
    expect(planThatRuns(pack)).toBe('plus')
    expect(planThatRuns({ ...vanilla, tier: '6g' })).toBeNull()
  })

  test('a disk is sized for the world, and grows with it well before it is full, up to the plan’s most', () => {
    const free = entitlementsFor('free')
    const plus = entitlementsFor('plus')
    // Every size starts on the same disk: a large server's world is no bigger to begin with.
    expect(free.storage.startGb).toBe(3)
    expect(plus.storage.startGb).toBe(5)
    const GB = 2 ** 30
    // On 5 GB, 1.5 GB free comes before a fifth free does; it grows at least 2 GB.
    expect(grownDisk(plus, 5, 3.4 * GB)).toBeNull()
    expect(grownDisk(plus, 5, 3.6 * GB)).toBe(7)
    // On 10 GB, a fifth free comes first, and the new disk leaves the world about a third free.
    expect(grownDisk(plus, 10, 7.9 * GB)).toBeNull()
    expect(grownDisk(plus, 10, 8.1 * GB)).toBe(12)
    expect(grownDisk(plus, 15, 13 * GB)).toBe(19)
    expect(grownDisk(plus, 19, 16 * GB)).toBe(20)
    expect(grownDisk(plus, 20, 19 * GB)).toBeNull()
    // Free's border keeps its world far inside its disk; it never grows.
    expect(grownDisk(free, 3, 2.9 * GB)).toBeNull()
  })

  test('a world brought back from a download gets a disk it fits on, as far as the plan grows', () => {
    const GB = 2 ** 30
    const free = entitlementsFor('free')
    const plus = entitlementsFor('plus')
    // 60% of the disk: 3 GB of world needs 5 GB, which Plus starts on already.
    expect(diskForWorld(plus, 5, 3 * GB)).toBeNull()
    expect(diskForWorld(plus, 5, 3.5 * GB)).toBe(6)
    expect(diskForWorld(plus, 5, 11 * GB)).toBe(19)
    // Past what a plan's disks grow to, nothing is promised.
    expect(diskForWorld(plus, 5, 13 * GB)).toBeNull()
    expect(diskForWorld(free, 3, 1.5 * GB)).toBeNull()
    expect(diskForWorld(free, 3, 2 * GB)).toBeNull()
  })

  test('the world data a plan is sized for alerts admins before one server could fill its disk', () => {
    const plus = entitlementsFor('plus')
    expect(plus.storage.paidForGb).toBe(10)
    // Across the account, past one starting disk and short of the largest one disk grows to.
    expect(plus.storage.paidForGb).toBeGreaterThan(plus.storage.startGb)
    expect(plus.storage.paidForGb).toBeLessThan(plus.storage.mostGb)
    expect(entitlementsFor('free').storage.paidForGb).toBe(3)
  })

  test('an unknown plan is the free one, and admin limits still override', () => {
    expect(entitlementsFor('nonesuch').plan).toBe('free')
    expect(entitlementsFor('free', { maxServers: 4, maxRunning: 2 })).toMatchObject({
      maxServers: 4,
      maxRunning: 2,
      includedUnits: 20,
    })
  })

  test('provider snapshots are kept as long as the longest plan needs', () => {
    expect(longestSnapshotNeedDays()).toBe(44)
  })
})

describe('meter', () => {
  test('an hour is an hour, and a large server uses two', () => {
    expect(unitsFor('3g', 2)).toBe(2)
    expect(unitsFor('4g', 2)).toBe(2)
    expect(unitsFor('8g', 2)).toBe(4)
    expect(unitsFor('6g', 2)).toBe(4)
    expect(isLarge('4g')).toBe(false)
    expect(isLarge('8g')).toBe(true)
  })

  test('an extra hour costs more than the plan’s own hours, and a large one twice that', () => {
    const plus = entitlementsFor('plus')
    expect(UNIT_CENTS).toBe(25)
    expect(plus.monthlyPriceCents / (plus.includedUnits ?? 1)).toBeLessThan(UNIT_CENTS)
    expect(centsFor(20)).toBe(500)
    expect(centsFor(unitsFor('8g', 1))).toBe(2 * centsFor(unitsFor('4g', 1)))
  })
})

describe('datapacks', () => {
  test('a datapack counts as a mod, Plus, until the owner decides whether plain Minecraft with one is Free', () => {
    const datapack = { tier: '3g' as const, loader: 'vanilla' as const, modded: false, datapacks: true }
    expect(entitlementsFor('free').mayUseDatapacks).toBe(false)
    expect(planGap(entitlementsFor('free'), datapack, 'offered')).toBe('datapacks')
    expect(planGap(entitlementsFor('plus'), datapack, 'offered')).toBeNull()
    expect(planThatRuns(datapack)).toBe('plus')
  })
})

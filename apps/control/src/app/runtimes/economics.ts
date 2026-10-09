import { type Db, schema } from '@blockly/db'
import { and, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { isMemoryTier, MEMORY_TIERS, memoryMb } from '../../domain/server/size.ts'
import type { RuntimeHandle, RuntimeMachine } from '../ports/runtime.ts'
import type { Runtimes } from './router.ts'

/**
 * What each runtime costs against what its servers bring in, from what Blockly recorded
 * (docs/runtimes.md §7): the hours servers ran on it and at what size, the play on them, their
 * storage and backups, the provider's list prices, the machines a runtime pays for whether full
 * or empty, and the orders their owners paid. A canary is measured on the deployment's own
 * numbers.
 *
 * What it can't see it says so rather than guess: bandwidth isn't measured anywhere yet; hours on
 * a runtime a server has since left are counted but not priced, since only the current handle can
 * be priced; a machine's price is its operator's label, prorated over the window as if the
 * machines today were there all along.
 */

/** The billing provider's fee on an order, as Polar publishes it (polar.sh/pricing). */
const PAYMENT_FEE = { percent: 5, fixedCents: 50 } as const
/** Cloudflare R2 Standard storage, a GB-month, for backups in the archive store. */
const ARCHIVE_GB_MONTH_CENTS = 1.5

const HOUR_MS = 3_600_000
const MONTH_HOURS = 730
const GB = 1024 ** 3

interface ServerEconomics {
  serverId: string
  name: string
  provider: string
  plan: string
  size: string
  memoryMb: number
  /** Hours its compute ran in the window, on any runtime. */
  runningHours: number
  /** Allocated memory over time: GB of its size times the hours it ran at it. */
  gbHours: number
  /** Hours anyone was playing, and player-hours, as the presence sync saw them. */
  activeHours: number
  playerHours: number
  peakPlayers: number
  /** The disk it holds at its provider, and what its world took when last measured. */
  storageGb: number
  diskUsedGb: number | null
  /** Ready backups: provider snapshots and copies in the archive store. */
  backupGb: number
  /** Its share of what it ran on, at list prices; null where nothing priced it. */
  infraCents: number | null
  /** Hours it ran on a runtime it has since left, which can't be priced now. */
  unpricedHours: number
  /** Its share of its owner's orders, and of their fees. */
  revenueCents: number
  feeCents: number
  marginCents: number | null
}

interface RuntimeEconomicsRow {
  provider: string
  /** Live servers bound to it now, and those that ran on it in the window. */
  servers: number
  serversRan: number
  runningHours: number
  gbHours: number
  activeHours: number
  playerHours: number
  storageGb: number
  backupGb: number
  /** What its servers cost by the server, at list price. */
  usageCents: number
  /** What its machines cost over the window, full or empty; 0 for a runtime billed by the server. */
  capacityCents: number
  /** Of that, the part no server was counted for: the price of room nobody used. */
  idleCents: number
  /**
   * For a runtime that pays for machines: the memory-hours its servers ran, as a share of the
   * memory-hours its machines offered. Machines are sized for the busiest evening and a spare, so
   * this is far below what they could run; it is what decides what an hour of play costs.
   */
  runningUtilization: number | null
  /** The archive store's share for the backups of its servers. */
  backupCents: number
  infraCents: number
  revenueCents: number
  feeCents: number
  marginCents: number
  marginPercent: number | null
  perServerCents: number | null
  perAllocatedGbMonthCents: number | null
  perRunningHourCents: number | null
  perPlayedHourCents: number | null
}

interface MachineEconomics extends RuntimeMachine {
  provider: string
  /**
   * Memory held for the servers running on it, or starting, as a share of what servers may use, as
   * the report was made; null where it reports none. `runningUtilization` is the same over the window.
   */
  utilization: number | null
  /** Memory it reported in use as a share of what servers may use. */
  observedUtilization: number | null
  /** Free memory no server size fits in, or that has no CPU left to go with it. */
  strandedMemoryMb: number
  windowCents: number | null
}

export interface EconomicsReport {
  from: string
  to: string
  hours: number
  assumptions: Record<string, string>
  runtimes: RuntimeEconomicsRow[]
  machines: MachineEconomics[]
  servers: ServerEconomics[]
  /** Orders from owners with no server to carry them in the window. */
  unattributedRevenueCents: number
}

const SMALLEST_MB = Math.min(...MEMORY_TIERS.map((tier) => memoryMb(tier)))

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places

export class RuntimeEconomics {
  readonly #db: Db
  readonly #runtimes: Runtimes

  constructor(deps: { db: Db; runtimes: Runtimes }) {
    this.#db = deps.db
    this.#runtimes = deps.runtimes
  }

  async report(window: { from: Date; to: Date }, limit = 500, now = new Date()): Promise<EconomicsReport> {
    // Nothing has run, or cost anything, past now: a window reaching on is read up to now.
    const from = window.from
    const to = new Date(Math.max(Math.min(window.to.getTime(), now.getTime()), from.getTime()))
    const hours = (to.getTime() - from.getTime()) / HOUR_MS
    const months = hours / MONTH_HOURS
    const servers = schema.minecraftServers
    const bindings = schema.serverRuntimes
    const intervals = schema.powerIntervals
    const usage = schema.serverUsageDays

    const live = await this.#db
      .select({
        id: servers.id,
        name: servers.name,
        ownerId: servers.ownerId,
        status: servers.status,
        memoryTier: servers.memoryTier,
        plan: schema.accountStanding.plan,
        provider: bindings.provider,
        handle: bindings.handle,
        storageGb: bindings.storageGb,
        diskUsedBytes: bindings.diskUsedBytes,
      })
      .from(servers)
      .innerJoin(bindings, eq(bindings.serverId, servers.id))
      .leftJoin(schema.accountStanding, eq(schema.accountStanding.userId, servers.ownerId))
      .where(ne(servers.status, 'purged'))
    const ids = live.map((row) => row.id)

    const ran =
      ids.length === 0
        ? []
        : await this.#db
            .select({
              serverId: intervals.serverId,
              provider: intervals.provider,
              memoryTier: intervals.memoryTier,
              hours: sql<string>`sum(extract(epoch from (least(coalesce(${intervals.stoppedAt}, ${to}), ${to}) - greatest(${intervals.startedAt}, ${from})))) / 3600`,
            })
            .from(intervals)
            .where(
              and(
                inArray(intervals.serverId, ids),
                lt(intervals.startedAt, to),
                gt(sql`coalesce(${intervals.stoppedAt}, ${to})`, from),
              ),
            )
            .groupBy(intervals.serverId, intervals.provider, intervals.memoryTier)
    const played = await this.#db
      .select({
        serverId: usage.serverId,
        provider: usage.provider,
        playerMinutes: sql<string>`sum(${usage.playerMinutes})`,
        activeMinutes: sql<string>`sum(${usage.activeMinutes})`,
        peak: sql<string>`max(${usage.peakPlayers})`,
      })
      .from(usage)
      .where(
        and(
          sql`${usage.day} >= ${from.toISOString().slice(0, 10)}`,
          // Every day the window touches: one ending at midnight ends the day before.
          sql`${usage.day} <= ${new Date(Math.max(to.getTime() - 1, from.getTime())).toISOString().slice(0, 10)}`,
        ),
      )
      .groupBy(usage.serverId, usage.provider)
    const backups = await this.#db
      .select({
        serverId: schema.backups.serverId,
        bytes: sql<string>`coalesce(sum(${schema.backups.sizeBytes}), 0)`,
      })
      .from(schema.backups)
      .where(eq(schema.backups.status, 'ready'))
      .groupBy(schema.backups.serverId)
    const orders = await this.#db
      .select({
        userId: schema.billingOrders.userId,
        revenue: sql<string>`sum(greatest(${schema.billingOrders.netCents} - ${schema.billingOrders.refundedCents}, 0))`,
        fees: sql<string>`sum(round(${schema.billingOrders.totalCents} * ${PAYMENT_FEE.percent / 100}::numeric) + ${PAYMENT_FEE.fixedCents}::numeric)`,
      })
      .from(schema.billingOrders)
      .where(and(sql`${schema.billingOrders.orderedAt} >= ${from}`, lt(schema.billingOrders.orderedAt, to)))
      .groupBy(schema.billingOrders.userId)

    const backupBytes = new Map(backups.map((row) => [row.serverId, Number(row.bytes)]))
    const perServer = new Map<string, ServerEconomics>()
    for (const row of live) {
      const plan = row.plan ?? 'free'
      const size = row.memoryTier
      const storageGb = Math.max(entitlementsFor(plan).storage.startGb, row.storageGb ?? 0)
      perServer.set(row.id, {
        serverId: row.id,
        name: row.name,
        provider: row.provider,
        plan,
        size,
        memoryMb: isMemoryTier(size) ? memoryMb(size) : 0,
        runningHours: 0,
        gbHours: 0,
        activeHours: 0,
        playerHours: 0,
        peakPlayers: 0,
        storageGb,
        diskUsedGb: row.diskUsedBytes === null ? null : round(row.diskUsedBytes / GB),
        backupGb: round((backupBytes.get(row.id) ?? 0) / GB),
        infraCents: null,
        unpricedHours: 0,
        revenueCents: 0,
        feeCents: 0,
        marginCents: null,
      })
    }

    // Time on each runtime, at each size, priced where the server still is.
    const byRuntime = new Map<string, RuntimeEconomicsRow>()
    const row = (provider: string): RuntimeEconomicsRow => {
      let found = byRuntime.get(provider)
      if (found === undefined) {
        found = {
          provider,
          servers: 0,
          serversRan: 0,
          runningHours: 0,
          gbHours: 0,
          activeHours: 0,
          playerHours: 0,
          storageGb: 0,
          backupGb: 0,
          usageCents: 0,
          capacityCents: 0,
          idleCents: 0,
          runningUtilization: null,
          backupCents: 0,
          infraCents: 0,
          revenueCents: 0,
          feeCents: 0,
          marginCents: 0,
          marginPercent: null,
          perServerCents: null,
          perAllocatedGbMonthCents: null,
          perRunningHourCents: null,
          perPlayedHourCents: null,
        }
        byRuntime.set(provider, found)
      }
      return found
    }
    for (const provider of this.#runtimes.providers) row(provider)
    const capacity = new Map(
      await Promise.all(
        this.#runtimes.providers.map(
          async (p) => [p, await this.#runtimes.capacity(p).catch(() => null)] as const,
        ),
      ),
    )
    const ranOn = new Map<string, Set<string>>()
    const liveById = new Map(live.map((r) => [r.id, r]))
    for (const interval of ran) {
      const server = perServer.get(interval.serverId)
      const bound = liveById.get(interval.serverId)
      if (server === undefined || bound === undefined) continue
      const h = Number(interval.hours)
      const provider = interval.provider ?? bound.provider
      const mb = isMemoryTier(interval.memoryTier) ? memoryMb(interval.memoryTier) : server.memoryMb
      server.runningHours += h
      server.gbHours += (h * mb) / 1024
      const target = row(provider)
      target.runningHours += h
      target.gbHours += (h * mb) / 1024
      ranOn.set(provider, (ranOn.get(provider) ?? new Set()).add(server.serverId))
      // A runtime that pays for machines is costed by its machines, below.
      if (capacity.get(provider)) continue
      if (provider !== bound.provider || bound.handle === null || !this.#runtimes.runs(provider)) {
        server.unpricedHours += h
        continue
      }
      const price = this.#runtimes.prices(bound.handle as RuntimeHandle, {
        memoryMb: mb,
        storageGb: server.storageGb,
      })
      if (price === null) continue
      server.infraCents = (server.infraCents ?? 0) + h * price.runningHourCents
    }
    for (const reading of played) {
      const server = perServer.get(reading.serverId)
      if (server === undefined) continue
      const playerHours = Number(reading.playerMinutes) / 60
      const activeHours = Number(reading.activeMinutes) / 60
      server.playerHours += playerHours
      server.activeHours += activeHours
      server.peakPlayers = Math.max(server.peakPlayers, Number(reading.peak))
      row(reading.provider).playerHours += playerHours
      row(reading.provider).activeHours += activeHours
    }

    // Storage held where each server is now, and its share of machines a runtime pays for.
    for (const bound of live) {
      const server = perServer.get(bound.id)
      if (server === undefined) continue
      const target = row(bound.provider)
      if (bound.status !== 'deleted') target.servers++
      target.storageGb += server.storageGb
      target.backupGb += server.backupGb
      if (bound.handle === null || !this.#runtimes.runs(bound.provider) || bound.status === 'stored') continue
      const price = this.#runtimes.prices(bound.handle as RuntimeHandle, {
        memoryMb: server.memoryMb,
        storageGb: server.storageGb,
      })
      if (price === null) continue
      server.infraCents = (server.infraCents ?? 0) + months * price.storageMonthCents
    }
    for (const server of perServer.values()) {
      if (server.infraCents === null) continue
      if (!capacity.get(server.provider)) row(server.provider).usageCents += server.infraCents
    }

    // Revenue: each owner's orders, shared among their servers by the memory-hours each ran.
    const byOwner = new Map<string, ServerEconomics[]>()
    for (const bound of live) {
      const server = perServer.get(bound.id)
      if (server !== undefined) byOwner.set(bound.ownerId, [...(byOwner.get(bound.ownerId) ?? []), server])
    }
    let unattributed = 0
    for (const order of orders) {
      const owned = (byOwner.get(order.userId) ?? []).filter(
        (s) => liveById.get(s.serverId)?.status !== 'deleted',
      )
      const revenue = Number(order.revenue)
      const fees = Number(order.fees)
      if (owned.length === 0) {
        unattributed += revenue
        continue
      }
      const weight = owned.reduce((sum, s) => sum + s.gbHours, 0)
      for (const server of owned) {
        const share = weight > 0 ? server.gbHours / weight : 1 / owned.length
        server.revenueCents += revenue * share
        server.feeCents += fees * share
      }
    }

    // Machines: their price over the window, what was placed on them, what nobody used.
    const machines: MachineEconomics[] = []
    for (const [provider, held] of capacity) {
      if (held === null) continue
      const target = row(provider)
      const offeredGbHours = held.machines.reduce((sum, m) => sum + (m.allocatableMemoryMb / 1024) * hours, 0)
      if (offeredGbHours > 0) target.runningUtilization = round(target.gbHours / offeredGbHours, 3)
      for (const machine of held.machines) {
        const free = Math.max(machine.allocatableMemoryMb - machine.allocatedMemoryMb, 0)
        const cpuFull = machine.cpus > 0 && machine.allocatedCpuMillis >= machine.cpus * 1000
        const windowCents = machine.monthlyCents === null ? null : machine.monthlyCents * months
        if (windowCents !== null) {
          target.capacityCents += windowCents
          if (machine.allocatableMemoryMb > 0)
            target.idleCents += (windowCents * free) / machine.allocatableMemoryMb
        }
        machines.push({
          ...machine,
          provider,
          utilization:
            machine.allocatableMemoryMb > 0
              ? round(machine.allocatedMemoryMb / machine.allocatableMemoryMb, 3)
              : null,
          observedUtilization:
            machine.usedMemoryMb === null || machine.allocatableMemoryMb <= 0
              ? null
              : round(machine.usedMemoryMb / machine.allocatableMemoryMb, 3),
          strandedMemoryMb: cpuFull || free < SMALLEST_MB ? free : 0,
          windowCents: windowCents === null ? null : round(windowCents),
        })
      }
    }

    for (const server of perServer.values()) {
      const target = row(server.provider)
      target.revenueCents += server.revenueCents
      target.feeCents += server.feeCents
      const backup = server.backupGb * months * ARCHIVE_GB_MONTH_CENTS
      target.backupCents += backup
      if (server.infraCents !== null)
        server.marginCents = round(server.revenueCents - server.feeCents - server.infraCents - backup)
      server.infraCents = server.infraCents === null ? null : round(server.infraCents)
      server.revenueCents = round(server.revenueCents)
      server.feeCents = round(server.feeCents)
      server.runningHours = round(server.runningHours)
      server.gbHours = round(server.gbHours)
      server.activeHours = round(server.activeHours)
      server.playerHours = round(server.playerHours)
      server.unpricedHours = round(server.unpricedHours)
    }
    for (const target of byRuntime.values()) {
      target.serversRan = ranOn.get(target.provider)?.size ?? 0
      target.infraCents = target.usageCents + target.capacityCents + target.backupCents
      target.marginCents = target.revenueCents - target.feeCents - target.infraCents
      target.marginPercent =
        target.revenueCents > 0 ? round(target.marginCents / target.revenueCents, 3) : null
      const per = (denominator: number) => (denominator > 0 ? round(target.infraCents / denominator) : null)
      target.perServerCents = per(target.servers)
      target.perAllocatedGbMonthCents = per(target.gbHours / MONTH_HOURS)
      target.perRunningHourCents = per(target.runningHours)
      target.perPlayedHourCents = per(target.activeHours)
      for (const key of [
        'runningHours',
        'gbHours',
        'activeHours',
        'playerHours',
        'storageGb',
        'backupGb',
        'usageCents',
        'capacityCents',
        'idleCents',
        'backupCents',
        'infraCents',
        'revenueCents',
        'feeCents',
        'marginCents',
      ] as const)
        target[key] = round(target[key])
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      hours: round(hours),
      assumptions: {
        paymentFee: `${PAYMENT_FEE.percent}% + ${PAYMENT_FEE.fixedCents}¢ an order, on its total with tax (Polar Starter, 2026-10-01)`,
        revenue:
          'orders in the window, after discounts and refunds, before tax; shared among each owner’s servers by the memory-hours each ran',
        usage:
          'the provider’s list prices for the hours each server ran, at the size it ran, where it is now',
        capacity:
          'each machine’s monthly_cost_cents label, prorated over the window, as if today’s machines were there all along',
        idle: 'the share of each machine’s price for memory no server was counted for',
        backups: `ready backups at ${ARCHIVE_GB_MONTH_CENTS}¢ a GB-month (R2 Standard), whichever runtime they came from`,
        playedHours:
          'minutes with anyone online, from the presence sync once a minute; missed readings count as no play',
        bandwidth: 'not measured: neither the edge nor any runtime counts bytes yet',
        actualUsage: 'per-server memory and CPU in use are not measured; machines report theirs',
      },
      runtimes: [...byRuntime.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
      machines,
      servers: [...perServer.values()]
        .filter((s) => s.runningHours > 0 || s.revenueCents > 0 || (s.infraCents ?? 0) > 0)
        .sort((a, b) => (b.infraCents ?? 0) - (a.infraCents ?? 0))
        .slice(0, limit),
      unattributedRevenueCents: round(unattributed),
    }
  }
}

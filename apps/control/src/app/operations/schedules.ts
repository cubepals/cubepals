// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The periodic work the control plane does outside any one server's queue (§9), one job to each
 * method: `main.node.ts` runs each on its schedule, and `EdgeService` asks `evaluateIdle`. Each job
 * is built once, here, from the few ports it uses, and owns what it keeps between passes; this
 * class only holds them. Closing stray usage intervals and refreshing the catalog are a couple of
 * calls each, and stay here. Operations themselves are `handlers/`'s.
 *
 * Parts (`schedules/`):
 * - `disk-growth.ts`: restarts a running world onto a bigger disk once it outgrows its own.
 * - `drift.ts`: applies a changed spec to running servers nobody is playing on, a few a pass.
 * - `expiring.ts`: sends to the trash a server whose time is up, warning first where a plan says.
 * - `idle.ts`: decides whether an empty running server has been idle long enough to stop.
 * - `observations.ts`: writes what a runtime said about a server's compute into its `observed` record.
 * - `orphans.ts`: stops compute no running server accounts for; destroys what no binding holds.
 * - `presence.ts`: records who is online on each running server, read from its console.
 * - `purge-sweep.ts`: queues again the decommission or purge a deleted server still owes.
 * - `reconcile.ts`: brings what is recorded in line with what the provider lists since the last pass.
 * - `relocations.ts`: asks for the moves the platform makes on its own, a few a pass.
 * - `scheduled-backups.ts`: queues the daily backups and retires the ones gone or past their lifetime.
 * - `session-cap.ts`: warns, then stops, a run that reaches its account's session cap.
 * - `spend.ts`: works out what today cost and, past the daily limit, pauses starts and creation.
 * - `store-sweep.ts`: hands servers idle past their plan's days to the `store` operation.
 * - `stray.ts`: finds compute the provider runs that no running server here accounts for.
 */
import type { Db } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import type { BackupService } from '../backups/service.ts'
import type { CatalogSync, CatalogTransition } from '../catalog/sync.ts'
import type { ListingService } from '../listings/service.ts'
import type { PlayerService } from '../players/service.ts'
import type { EventBus } from '../ports/events.ts'
import type { ServerConsole } from '../ports/minecraft.ts'
import type { Mailer } from '../ports/platform.ts'
import type { Runtimes } from '../runtimes/router.ts'
import type { RuntimePlacement } from '../runtimes/service.ts'
import type { MinecraftServerService } from '../servers/service.ts'
import type { RuntimeSpecs } from '../servers/specs.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import { closeInterval, strayIntervals } from '../servers/usage.ts'
import { growingDisks } from './schedules/disk-growth.ts'
import { drifting } from './schedules/drift.ts'
import { expiring } from './schedules/expiring.ts'
import { type IdleDecision, idleStops } from './schedules/idle.ts'
import { clearingOrphans } from './schedules/orphans.ts'
import { readingPresence } from './schedules/presence.ts'
import { purging } from './schedules/purge-sweep.ts'
import { reconciling } from './schedules/reconcile.ts'
import { relocating } from './schedules/relocations.ts'
import { schedulingBackups } from './schedules/scheduled-backups.ts'
import { sessionCaps } from './schedules/session-cap.ts'
import { type SpendCheck, SpendWatchdog } from './schedules/spend.ts'
import { storingIdle } from './schedules/store-sweep.ts'

export { IDLE_GRACE_MS, type IdleDecision, WAKE_PROBATION_MS } from './schedules/idle.ts'
export { HOST_LOSS_GRACE_MS, RELOCATION_RETRY_MS } from './schedules/relocations.ts'

/**
 * Periodic work outside any one server's queue: noticing crashes, reading who is online,
 * stopping idle servers, and cleaning up what nothing owns any more.
 */
export class Schedules {
  readonly #db: Db
  readonly #catalog: CatalogSync
  readonly #listings: ListingService
  readonly #idle: ReturnType<typeof idleStops>
  readonly #reconcile: (now: Date) => Promise<void>
  readonly #relocations: (now: Date, limit: number) => Promise<number>
  readonly #drift: (limit: number) => Promise<number>
  readonly #scheduledBackups: (now: Date, limit: number) => Promise<number>
  readonly #presenceSync: () => Promise<void>
  readonly #sessionCheck: (now: Date) => Promise<number>
  readonly #diskCheck: (now: Date) => Promise<number>
  readonly #orphans: () => Promise<void>
  readonly #purgeSweep: (now: Date) => Promise<void>
  readonly #storeSweep: (now: Date, limit: number) => Promise<number>
  readonly #expiring: ReturnType<typeof expiring>
  readonly #spend: SpendWatchdog

  constructor(deps: {
    db: Db
    runtime: Runtimes
    /** Records how an operator's move of a resting server between runtimes ended. */
    placement: RuntimePlacement
    console: ServerConsole
    specs: RuntimeSpecs
    transitions: ServerTransitions
    events: EventBus
    service: MinecraftServerService
    backups: BackupService
    catalog: CatalogSync
    listings: ListingService
    /** What waits for a player is delivered when a presence reading sees them join. */
    players: Pick<PlayerService, 'deliverWaiting'>
    /** Whether the deployment keeps archives, which a resting world lives in. */
    storing: boolean
    mailer: Mailer
    webOrigin: string
    /** When this process started: until presence is read again after it, activity is unknown. */
    startedAt?: Date
  }) {
    this.#db = deps.db
    this.#catalog = deps.catalog
    this.#listings = deps.listings
    this.#idle = idleStops({ db: deps.db, service: deps.service, startedAt: deps.startedAt ?? new Date() })
    this.#reconcile = reconciling({ db: deps.db, runtime: deps.runtime, transitions: deps.transitions })
    this.#relocations = relocating({
      db: deps.db,
      runtime: deps.runtime,
      specs: deps.specs,
      placement: deps.placement,
      service: deps.service,
    })
    this.#drift = drifting({
      db: deps.db,
      runtime: deps.runtime,
      specs: deps.specs,
      transitions: deps.transitions,
    })
    this.#scheduledBackups = schedulingBackups({
      db: deps.db,
      runtime: deps.runtime,
      transitions: deps.transitions,
      backups: deps.backups,
      events: deps.events,
    })
    this.#presenceSync = readingPresence({
      db: deps.db,
      runtime: deps.runtime,
      console: deps.console,
      specs: deps.specs,
      events: deps.events,
      transitions: deps.transitions,
      players: deps.players,
    })
    this.#sessionCheck = sessionCaps({
      db: deps.db,
      runtime: deps.runtime,
      console: deps.console,
      specs: deps.specs,
      events: deps.events,
      service: deps.service,
    })
    this.#diskCheck = growingDisks({
      db: deps.db,
      runtime: deps.runtime,
      console: deps.console,
      specs: deps.specs,
      service: deps.service,
    })
    this.#orphans = clearingOrphans({ db: deps.db, runtime: deps.runtime })
    this.#purgeSweep = purging({ db: deps.db, transitions: deps.transitions })
    this.#storeSweep = storingIdle({ db: deps.db, storing: deps.storing, transitions: deps.transitions })
    this.#spend = new SpendWatchdog({
      db: deps.db,
      runtime: deps.runtime,
      mailer: deps.mailer,
      webOrigin: deps.webOrigin,
    })
    this.#expiring = expiring({
      db: deps.db,
      mailer: deps.mailer,
      webOrigin: deps.webOrigin,
      service: deps.service,
    })
  }

  /**
   * `catalog-refresh` (§15.3): every tracked state read again, then the listings pinning what
   * moved are looked at again.
   */
  async catalogRefresh(): Promise<CatalogTransition[]> {
    const transitions = await this.#catalog.refresh()
    await this.#listings.catalogMoved(transitions)
    return transitions
  }

  /**
   * `usage-close`: power intervals are closed by the stop that ends them; one still open on a
   * server that isn't running ends when the server last changed, so run hours never count time
   * a server spent off.
   */
  async usageClose(): Promise<number> {
    const stray = await strayIntervals(this.#db)
    for (const { serverId, lastChanged } of stray) await closeInterval(this.#db, serverId, lastChanged)
    return stray.length
  }

  async reconcile(now = new Date()): Promise<void> {
    return this.#reconcile(now)
  }

  async relocations(now = new Date(), limit = 3): Promise<number> {
    return this.#relocations(now, limit)
  }

  async drift(limit = 5): Promise<number> {
    return this.#drift(limit)
  }

  async backups(now = new Date(), limit = 20): Promise<number> {
    return this.#scheduledBackups(now, limit)
  }

  async presenceSync(): Promise<void> {
    return this.#presenceSync()
  }

  async idleCheck(now = new Date()): Promise<void> {
    return this.#idle.idleCheck(now)
  }

  async sessionCheck(now = new Date()): Promise<number> {
    return this.#sessionCheck(now)
  }

  async diskCheck(now = new Date()): Promise<number> {
    return this.#diskCheck(now)
  }

  async evaluateIdle(server: MinecraftServer, now = new Date()): Promise<IdleDecision> {
    return this.#idle.evaluateIdle(server, now)
  }

  async orphans(): Promise<void> {
    return this.#orphans()
  }

  async purgeSweep(now = new Date()): Promise<void> {
    return this.#purgeSweep(now)
  }

  async storeSweep(now = new Date(), limit = 10): Promise<number> {
    return this.#storeSweep(now, limit)
  }

  async retentionSweep(now = new Date(), limit = 50): Promise<{ warned: number; deleted: number }> {
    return this.#expiring.retentionSweep(now, limit)
  }

  async expirySweep(now = new Date()): Promise<number> {
    return this.#expiring.expirySweep(now)
  }

  /** `spend-watchdog`: today's spend, written down, and past the limit, starts and creation off. */
  async spendCheck(now = new Date()): Promise<SpendCheck> {
    return this.#spend.check(now)
  }
}

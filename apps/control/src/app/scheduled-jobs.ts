// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The worker's scheduled jobs, each with the work it runs and what the log says of a pass. When
 * each runs is the job queue's (`infra/pg/jobs.ts`); this is only what each does, over the control
 * plane's services.
 */

import { dollars } from '../domain/policy/spend.ts'
import type { ControlPlane } from './control-plane.ts'
import type { Schedule } from './ports/jobs.ts'

/** What each scheduled job does; `infra/pg/jobs.ts` says when each runs. */
export function scheduledJobs(
  app: ControlPlane,
  provider: { fleet?: { runtime: { upkeep(): Promise<void> } } },
): Schedule[] {
  return [
    { job: 'reconcile', run: () => app.schedules.reconcile() },
    { job: 'drift', run: () => app.schedules.drift() },
    { job: 'relocations', run: () => app.schedules.relocations(), says: (n) => `moved ${n}` },
    { job: 'presence-sync', run: () => app.schedules.presenceSync() },
    { job: 'idle-check', run: () => app.schedules.idleCheck() },
    { job: 'creates-room', run: () => app.policy.room.settle() },
    {
      job: 'session-check',
      run: () => app.schedules.sessionCheck(),
      says: (n) => `stopped ${n} at their plan's session cap`,
    },
    {
      job: 'disk-check',
      run: () => app.schedules.diskCheck(),
      says: (n) => `gave ${n} more room while they ran`,
    },
    { job: 'orphans', run: () => app.schedules.orphans() },
    { job: 'purge-sweep', run: () => app.schedules.purgeSweep() },
    {
      job: 'expiry-sweep',
      run: () => app.schedules.expirySweep(),
      says: (n) => `deleted ${n} servers made for a while`,
    },
    {
      job: 'store-sweep',
      run: () => app.schedules.storeSweep(),
      says: (n) => `resting ${n} worlds nobody plays`,
    },
    {
      job: 'retention-sweep',
      run: async () => {
        const { warned, deleted } = await app.schedules.retentionSweep()
        if (warned + deleted > 0) console.warn(`retention-sweep: warned ${warned}, deleted ${deleted}`)
      },
    },
    { job: 'backup-schedule', run: () => app.schedules.backups() },
    { job: 'listing-eligibility-sweep', run: () => app.listings.sweep() },
    {
      job: 'standing-sweep',
      run: async () => {
        const lapsed = await app.billing.sweep()
        if (lapsed > 0) console.warn(`standing: recorded ${lapsed} lapsed subscriptions`)
        const enforced = await app.accounts.enforce()
        if (enforced.stopped + enforced.closed > 0)
          console.warn(`standing: stopped ${enforced.stopped}, closed ${enforced.closed}`)
      },
    },
    {
      job: 'extra-play-report',
      // Play hours chipped in covered is drawn first: it is never counted as extra.
      run: async () => {
        await app.billing.chipIns.draw()
        await app.billing.usage.report()
      },
    },
    {
      job: 'artifact-gc',
      run: async () => {
        const collected = await app.artifacts.collectGarbage()
        if (collected.uploads + collected.blobs > 0)
          console.warn(
            `artifact-gc: ${collected.uploads} unfinished uploads, ${collected.blobs} unused blobs`,
          )
      },
    },
    // A catalog that can't be reached leaves the cache as it was; `admin-alerts` says so after 6 h.
    {
      job: 'catalog-refresh',
      run: async () => {
        for (const t of await app.schedules.catalogRefresh())
          console.warn(`catalog: ${t.kind} ${t.id} ${t.from ?? 'new'} → ${t.to}`)
      },
    },
    {
      job: 'compat-pins',
      run: () => app.setups.compat.refresh(),
      says: (n) => `pinned the Via plugins for ${n} releases`,
    },
    {
      job: 'malware-lists',
      run: () => app.jarChecks.refresh(),
      says: (n) => `quarantined ${n} uploaded jars a list now names`,
    },
    {
      job: 'pack-checks',
      run: () => app.setups.checkBrowsed(),
      says: (n) => `checked ${n} packs of the default list`,
    },
    {
      job: 'curation',
      run: () => app.curation.queueDue(),
      says: (n) => `queued ${n} reviewed releases to check`,
    },
    {
      job: 'usage-close',
      run: () => app.schedules.usageClose(),
      says: (n) => `closed ${n} power intervals left open`,
    },
    { job: 'provider-tags', run: () => app.fleet.tag(), says: (n) => `tagged ${n} servers at the provider` },
    // The day's figure goes to the log every pass, tripped or not.
    {
      job: 'spend-watchdog',
      run: async () => {
        const day = await app.schedules.spendCheck()
        console.warn(
          `spend-watchdog: ${day.day} ${dollars(day.cents)} of ${dollars(day.limitCents)} (compute ${dollars(day.computeCents)}, stray ${dollars(day.strayCents)} on ${day.strayMachines}, disks ${dollars(day.storageCents)}), ${day.runningServers} running`,
        )
        if (day.tripped)
          console.error('spend-watchdog: past the daily limit; starts and creation are now off')
        // Machines running with no running server behind them are stopped now, not at :17.
        if (day.strayMachines > 0) await app.schedules.orphans()
      },
    },
    {
      job: 'free-play-links',
      run: () => app.accounts.freePlay.relink(),
      says: (n) => `${n} free accounts now share another's free hours`,
    },
    {
      job: 'admin-alerts',
      run: async () => {
        const { cleared } = await app.alerts.sweep()
        for (const key of cleared) console.warn(`admin alert cleared: ${key}`)
      },
    },
    // What a runtime keeps tidy behind its port; only the fleet has any.
    { job: 'runtime-upkeep', run: async () => provider.fleet?.runtime.upkeep() },
    { job: 'insight-send', run: () => app.insight.drain() },
  ]
}

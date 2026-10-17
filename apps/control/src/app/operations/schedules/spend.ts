// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The spend watchdog: works out what today has cost from what the control
 * plane recorded, and when it passes the platform's daily limit, turns off starts and creation,
 * audits that as the system, and emails the admins. It turns nothing back on: that is an admin's
 * call, on the platform page. The prices and the arithmetic are `domain/policy/spend.ts`'s;
 * finding compute nobody accounts for is `stray.ts`'s, and stopping it `orphans.ts`'s.
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import { type Db, schema } from '@blockly/db'
import { entitlementsFor } from '../../../domain/account/entitlements.ts'
import { type DaySpend, daySpend, overLimit, utcDay } from '../../../domain/policy/spend.ts'
import { adminInbox, countServers, loadControls, lockCapacity } from '../../accounts/persistence.ts'
import { type Actor, requestedBy } from '../../actor.ts'
import { spendLimit } from '../../emails/admins.ts'
import { pickControls } from '../../platform/controls.ts'
import {
  disksHeld,
  loadSpendDay,
  markSpendNotified,
  markSpendTripped,
  recordJobFailed,
  recordJobSucceeded,
  runsBetween,
  saveControls,
  saveSpendDay,
} from '../../platform/persistence.ts'
import type { Mailer } from '../../ports/platform.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { type StrayCompute, strayCompute } from './stray.ts'

/** The watchdog is the platform's own doing, not an admin's. */
const WATCHDOG: Actor = { kind: 'system', reason: 'spend' }

/** Where whether a pass got today's figure is written down (`job_health`). */
export const SPEND_FIGURE = 'spend-figure'
/** How long without a figure before admins hear of it (`spend_unread`): three passes. */
export const SPEND_UNREAD_MS = 30 * MINUTE_MS

export interface SpendCheck extends DaySpend {
  day: string
  limitCents: number
  strayMachines: number
  runningServers: number
  /** Whether this pass turned starts and creation off. */
  tripped: boolean
}

export class SpendWatchdog {
  readonly #db: Db
  readonly #runtime: Pick<Runtimes, 'observeChanged' | 'providers' | 'sameCompute'>
  readonly #mailer: Mailer
  readonly #webOrigin: string
  readonly #inbox: readonly string[]

  constructor(deps: {
    db: Db
    runtime: Pick<Runtimes, 'observeChanged' | 'providers' | 'sameCompute'>
    mailer: Mailer
    webOrigin: string
    /** ADMIN_ALERT_EMAILS; empty or absent, every admin's own email. */
    adminInbox?: readonly string[]
  }) {
    this.#db = deps.db
    this.#runtime = deps.runtime
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
    this.#inbox = deps.adminInbox ?? []
  }

  /**
   * `spend-watchdog`: today's figure, written down every pass; past the limit, the switches go
   * off once a day. An admin who turns them back on that day is not overruled until the next one.
   * A provider that can't be read ends the pass before anything is written: no figure beats a low one.
   * Each pass writes down whether it got one, and what stopped it, so a run of them without raises
   * `spend_unread` for the admins; the next figure clears it.
   */
  async check(now = new Date()): Promise<SpendCheck> {
    const { from, day } = utcDay(now)
    let strays: StrayCompute[]
    try {
      strays = await strayCompute(this.#db, this.#runtime)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordJobFailed(this.#db, SPEND_FIGURE, now, message)
      throw error
    }
    const spend = daySpend({
      from,
      to: now,
      runs: await runsBetween(this.#db, from, now),
      stray: strays.map((s) => ({ tier: s.tier, since: s.since })),
      diskGb: (await disksHeld(this.#db)).reduce(
        (sum, d) => sum + Math.max(entitlementsFor(d.plan ?? 'free').storage.startGb, d.grownGb ?? 0),
        0,
      ),
    })
    const { running } = await countServers(this.#db)
    const counts = { strayMachines: strays.length, runningServers: running }
    await saveSpendDay(this.#db, day, spend, counts, now)
    await recordJobSucceeded(this.#db, SPEND_FIGURE, now)
    const { dailySpendLimitCents: limitCents } = await loadControls(this.#db)
    const tripped = overLimit(spend, limitCents) && (await this.#trip(day, spend, limitCents, now))
    await this.#tell(day, limitCents, now)
    return { day, ...spend, ...counts, limitCents, tripped }
  }

  /** Starts and creation off, under the capacity lock, audited as the watchdog. */
  async #trip(day: string, spend: DaySpend, limitCents: number, now: Date): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      await lockCapacity(tx)
      if (!(await markSpendTripped(tx, day, now))) return false
      const controls = await loadControls(tx)
      const changes = Object.fromEntries(
        (['startsEnabled', 'provisioningEnabled'] as const)
          .filter((key) => controls[key])
          .map((key) => [key, { from: true, to: false }]),
      )
      const by = requestedBy(WATCHDOG)
      if (Object.keys(changes).length > 0) {
        await saveControls(
          tx,
          { ...pickControls(controls), startsEnabled: false, provisioningEnabled: false },
          by,
        )
        await tx.insert(schema.auditLog).values({
          actor: by,
          action: 'platform.controls_changed',
          subjectType: 'platform',
          subjectId: 'controls',
          data: changes,
        })
      }
      await tx.insert(schema.auditLog).values({
        actor: by,
        action: 'platform.spend_limit_reached',
        subjectType: 'platform',
        subjectId: 'spend',
        data: { day, limitCents, ...spend },
      })
      return true
    })
  }

  /** The admin inbox, once a day that tripped, until every email went out. */
  async #tell(day: string, limitCents: number, now: Date): Promise<void> {
    const record = await loadSpendDay(this.#db, day)
    if (record === null || record.trippedAt === null || record.notifiedAt !== null) return
    const email = spendLimit({
      cents: record.cents,
      limitCents,
      day,
      computeCents: record.computeCents,
      strayCents: record.strayCents,
      strayMachines: record.strayMachines,
      storageCents: record.storageCents,
      origin: this.#webOrigin,
    })
    let told = true
    for (const to of await adminInbox(this.#db, this.#inbox)) {
      try {
        await this.#mailer.send({ to, ...email })
      } catch (error) {
        told = false
        console.error(`spend watchdog email to ${to} failed`, error)
      }
    }
    if (told) await markSpendNotified(this.#db, day, now)
  }
}

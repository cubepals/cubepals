/**
 * The spend watchdog (docs/money-guards.md): works out what today has cost from what the control
 * plane recorded, and when it passes the platform's daily limit, turns off starts and creation,
 * audits that as the system, and emails the admins. It turns nothing back on: that is an admin's
 * call, on the platform page. The prices and the arithmetic are `domain/policy/spend.ts`'s;
 * finding compute nobody accounts for is `stray.ts`'s, and stopping it `orphans.ts`'s.
 */
import { type Db, schema } from '@blockly/db'
import { entitlementsFor } from '../../../domain/account/entitlements.ts'
import { type DaySpend, daySpend, overLimit, utcDay } from '../../../domain/policy/spend.ts'
import { countServers, listAdmins, loadControls, lockCapacity } from '../../accounts/persistence.ts'
import { type Actor, requestedBy } from '../../actor.ts'
import { spendLimit } from '../../emails/admins.ts'
import { pickControls } from '../../platform/controls.ts'
import {
  disksHeld,
  loadSpendDay,
  markSpendNotified,
  markSpendTripped,
  runsBetween,
  saveControls,
  saveSpendDay,
} from '../../platform/persistence.ts'
import type { Mailer } from '../../ports/platform.ts'
import type { Runtimes } from '../../runtimes/router.ts'
import { strayCompute } from './stray.ts'

/** The watchdog is the platform's own doing, not an admin's. */
const WATCHDOG: Actor = { kind: 'system', reason: 'spend' }

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

  constructor(deps: {
    db: Db
    runtime: Pick<Runtimes, 'observeChanged' | 'providers' | 'sameCompute'>
    mailer: Mailer
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#runtime = deps.runtime
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
  }

  /**
   * `spend-watchdog`: today's figure, written down every pass; past the limit, the switches go
   * off once a day. An admin who turns them back on that day is not overruled until the next one.
   * A provider that can't be read ends the pass before anything is written: no figure beats a low one.
   */
  async check(now = new Date()): Promise<SpendCheck> {
    const { from, day } = utcDay(now)
    const strays = await strayCompute(this.#db, this.#runtime)
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

  /** The admins, once a day that tripped, until every email went out. */
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
    for (const admin of await listAdmins(this.#db)) {
      try {
        await this.#mailer.send({ to: admin.email, ...email })
      } catch (error) {
        told = false
        console.error(`spend watchdog email to ${admin.email} failed`, error)
      }
    }
    if (told) await markSpendNotified(this.#db, day, now)
  }
}

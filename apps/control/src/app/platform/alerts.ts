import type { AlertKey, AlertView } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import { entitlementsFor, PLAN_KEYS } from '../../domain/account/entitlements.ts'
import { listAdmins, loadStanding } from '../accounts/persistence.ts'
import type { Actor } from '../actor.ts'
import { unsentExtra } from '../billing/extra-usage.ts'
import type { CatalogSync } from '../catalog/sync.ts'
import { adminAlert } from '../emails/admins.ts'
import { NotFound } from '../errors.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { Mailer } from '../ports/platform.ts'
import {
  alertNotified,
  clearAlert,
  loadAlerts,
  overduePurges,
  raiseAlert,
  restateAlert,
  worldDataByAccount,
} from './persistence.ts'
import { PURGE_GRACE_MS } from './stuck.ts'

/** Where an admin deals with each alert. */
const WHERE: Record<AlertKey, string> = {
  blocked_operations: '/admin/operations',
  purge_overdue: '/admin/operations',
  catalog_stale: '/admin/platform',
  worlds_outgrow_plan: '/admin/accounts',
  extra_play_unsent: '/admin/accounts',
}

interface Condition {
  key: AlertKey
  summary: string
}

/**
 * What needs an admin (§9 blocked keys and failing purges, §15.3 a stale catalog). The admin
 * pages read the conditions live; the `admin-alerts` sweep records when each was raised and
 * cleared, and emails every admin once when one is raised.
 */
export class PlatformAlerts {
  readonly #db: Db
  readonly #jobs: JobQueue
  readonly #catalog: CatalogSync
  readonly #mailer: Mailer
  readonly #webOrigin: string

  constructor(deps: { db: Db; jobs: JobQueue; catalog: CatalogSync; mailer: Mailer; webOrigin: string }) {
    this.#db = deps.db
    this.#jobs = deps.jobs
    this.#catalog = deps.catalog
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
  }

  async active(actor: Actor, now = new Date()): Promise<AlertView[]> {
    if (actor.kind !== 'admin') throw new NotFound('Alerts')
    const stored = await loadAlerts(this.#db)
    return (await this.#conditions(now)).map((c) => {
      const record = stored.get(c.key)
      const since = record !== undefined && record.clearedAt === null ? record.raisedAt : now
      return { ...c, since: since.toISOString(), href: WHERE[c.key] }
    })
  }

  /** `admin-alerts`: raise what appeared, clear what passed, and tell admins about the new. */
  async sweep(now = new Date()): Promise<{ raised: AlertKey[]; cleared: AlertKey[] }> {
    const conditions = await this.#conditions(now)
    const stored = await loadAlerts(this.#db)
    const raised: AlertKey[] = []
    const cleared: AlertKey[] = []
    for (const condition of conditions) {
      const record = stored.get(condition.key)
      if (record === undefined || record.clearedAt !== null) {
        await raiseAlert(this.#db, condition.key, condition.summary, now)
        raised.push(condition.key)
      } else if (record.summary !== condition.summary) {
        await restateAlert(this.#db, condition.key, condition.summary)
      }
    }
    for (const record of stored.values()) {
      if (record.clearedAt !== null || conditions.some((c) => c.key === record.key)) continue
      await clearAlert(this.#db, record.key, now)
      cleared.push(record.key as AlertKey)
    }
    // Raised ones, and any whose email didn't go out last time.
    const unsent = conditions.filter(
      (c) => raised.includes(c.key) || (stored.get(c.key)?.notifiedAt === null && !cleared.includes(c.key)),
    )
    for (const condition of unsent) {
      console.error(`admin alert: ${condition.summary}`)
      if (await this.#tell(condition)) await alertNotified(this.#db, condition.key, now)
    }
    return { raised, cleared }
  }

  async #conditions(now: Date): Promise<Condition[]> {
    const conditions: Condition[] = []
    const blocked = await this.#jobs.blockedOperations()
    if (blocked.length > 0)
      conditions.push({
        key: 'blocked_operations',
        summary: `${blocked.length} ${blocked.length === 1 ? 'operation is' : 'operations are'} stuck after ${blocked.length === 1 ? 'its job' : 'their jobs'} failed, holding up ${blocked.length === 1 ? 'a server' : 'servers'}.`,
      })
    const purges = await overduePurges(this.#db, new Date(now.getTime() - PURGE_GRACE_MS))
    if (purges.length > 0)
      conditions.push({
        key: 'purge_overdue',
        summary: `${purges.length} deleted ${purges.length === 1 ? 'server is' : 'servers are'} past ${purges.length === 1 ? 'its' : 'their'} purge date and still not purged.`,
      })
    const stale = await this.#catalog.staleSince(now)
    if (stale !== null) {
      const hours = Math.floor((now.getTime() - stale.getTime()) / 3_600_000)
      conditions.push({
        key: 'catalog_stale',
        summary: `The mod catalog hasn't answered a refresh for ${hours} hours; trust uses what it knew then.`,
      })
    }
    // Accounts whose worlds take more than their plan is sized for. Nothing is done
    // to them: their disks keep growing so no world ever runs out of room, and this is how the
    // owner learns what that costs.
    const least = Math.min(...PLAN_KEYS.map((plan) => entitlementsFor(plan).storage.paidForGb))
    let outgrown = 0
    for (const { ownerId, bytes } of await worldDataByAccount(this.#db, least * 2 ** 30)) {
      const standing = await loadStanding(this.#db, ownerId, now)
      if (bytes > entitlementsFor(standing.plan, standing.limitOverrides).storage.paidForGb * 2 ** 30)
        outgrown++
    }
    if (outgrown > 0)
      conditions.push({
        key: 'worlds_outgrow_plan',
        summary: `${outgrown} ${outgrown === 1 ? 'account keeps' : 'accounts keep'} more world data than ${outgrown === 1 ? 'its plan covers' : 'their plans cover'}, and ${outgrown === 1 ? 'costs' : 'cost'} more than ${outgrown === 1 ? 'it pays' : 'they pay'}.`,
      })
    conditions.push(...(await unsentCondition(this.#db)))
    return conditions
  }

  /** Emails every admin; true once it went to all of them. */
  async #tell(condition: Condition): Promise<boolean> {
    const admins = await listAdmins(this.#db)
    let told = true
    for (const admin of admins) {
      try {
        await this.#mailer.send({
          to: admin.email,
          ...adminAlert({ summary: condition.summary, path: WHERE[condition.key], origin: this.#webOrigin }),
        })
      } catch (error) {
        told = false
        console.error(`admin alert email to ${admin.email} failed`, error)
      }
    }
    return told
  }
}

/** Extra play Polar refused until it was no longer sent: hours played and never billed. */
async function unsentCondition(db: Db): Promise<Condition[]> {
  const { events, milli } = await unsentExtra(db)
  if (events === 0) return []
  const one = events === 1
  return [
    {
      key: 'extra_play_unsent',
      summary: `${events} extra-play ${one ? 'event' : 'events'} (${milli / 1000} h) Polar kept refusing ${one ? 'is' : 'are'} no longer sent and won't be billed; each is on its account's audit log as billing.extra_unsent.`,
    },
  ]
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { AlertKey, AlertView } from '@blockly/contracts'
import { HOUR_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { entitlementsFor, PLAN_KEYS } from '../../domain/account/entitlements.ts'
import { unreviewedLinks } from '../accounts/free-play.ts'
import { adminInbox, loadStanding } from '../accounts/persistence.ts'
import type { Actor } from '../actor.ts'
import { unsentExtra, waitingExtra } from '../billing/extra-usage.ts'
import { unknownOrders } from '../billing/persistence.ts'
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
  extra_play_waiting: '/admin/platform',
  billing_order_unknown: '/admin/accounts',
  free_accounts_linked: '/admin',
}

interface Condition {
  key: AlertKey
  summary: string
}

/**
 * What needs an admin (§9 blocked keys and failing purges, §15.3 a stale catalog). The admin
 * pages read the conditions live; the `admin-alerts` sweep records when each was raised and
 * cleared, and emails the admin inbox once when one is raised: ADMIN_ALERT_EMAILS, or every
 * admin when it lists none.
 */
export class PlatformAlerts {
  readonly #db: Db
  readonly #jobs: JobQueue
  readonly #catalog: CatalogSync
  readonly #mailer: Mailer
  readonly #webOrigin: string
  readonly #inbox: readonly string[]

  constructor(deps: {
    db: Db
    jobs: JobQueue
    catalog: CatalogSync
    mailer: Mailer
    webOrigin: string
    /** ADMIN_ALERT_EMAILS; empty or absent, every admin's own email. */
    adminInbox?: readonly string[]
  }) {
    this.#db = deps.db
    this.#jobs = deps.jobs
    this.#catalog = deps.catalog
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
    this.#inbox = deps.adminInbox ?? []
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
      const hours = Math.floor((now.getTime() - stale.getTime()) / HOUR_MS)
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
    conditions.push(
      ...(await unsentCondition(this.#db)),
      ...(await waitingCondition(this.#db, now)),
      ...(await unknownCondition(this.#db)),
      ...(await linkedCondition(this.#db)),
    )
    return conditions
  }

  /** Emails the admin inbox; true once it went to every address in it. */
  async #tell(condition: Condition): Promise<boolean> {
    let told = true
    for (const to of await adminInbox(this.#db, this.#inbox)) {
      try {
        await this.#mailer.send({
          to,
          ...adminAlert({ summary: condition.summary, path: WHERE[condition.key], origin: this.#webOrigin }),
        })
      } catch (error) {
        told = false
        console.error(`admin alert email to ${to} failed`, error)
      }
    }
    return told
  }
}

/**
 * Accounts Blockly linked as one person's free hours that no admin has looked at, in groups sure
 * enough to show (`medium`): those it is surest of share them already, and an admin decides whether
 * to hold or release them.
 */
async function linkedCondition(db: Db): Promise<Condition[]> {
  const linked = await unreviewedLinks(db)
  if (linked === 0) return []
  const one = linked === 1
  return [
    {
      key: 'free_accounts_linked',
      summary: `${linked} ${one ? 'pair of accounts looks' : 'pairs of accounts look'} like one person's free hours (one inbox, or one main player). Those Cubepals is sure of share them now; hold or release ${one ? 'it' : 'them'} under Linked accounts.`,
    },
  ]
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

/**
 * Extra play Polar hasn't taken for an hour: it is down, or refuses Blockly's token. Nothing is
 * lost; it is sent once Polar takes it, and billed on the payment after.
 */
async function waitingCondition(db: Db, now: Date): Promise<Condition[]> {
  const { events, milli, lastError } = await waitingExtra(db, now)
  if (events === 0) return []
  const one = events === 1
  return [
    {
      key: 'extra_play_waiting',
      summary: `${events} extra-play ${one ? 'event' : 'events'} (${milli / 1000} h) ${one ? 'has' : 'have'} waited over an hour for Polar to take ${one ? 'it' : 'them'}. Polar said: ${(lastError ?? '').slice(0, 200)}`,
    },
  ]
}

/** Unpaid charges carrying extra play Polar says it doesn't know: never owed until it does. */
async function unknownCondition(db: Db): Promise<Condition[]> {
  const orders = await unknownOrders(db)
  if (orders === 0) return []
  const one = orders === 1
  return [
    {
      key: 'billing_order_unknown',
      summary: `${orders} unpaid ${one ? 'charge' : 'charges'} carrying extra play ${one ? 'is' : 'are'} unknown to Polar, so ${one ? 'it is' : 'they are'} never owed until Polar knows ${one ? 'it' : 'them'}; each is asked about once a day, and is on its account's audit log as billing.order_unknown.`,
    },
  ]
}

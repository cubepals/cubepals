// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { AlertKey, AlertView } from '@blockly/contracts'
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { Db } from '@blockly/db'
import { entitlementsFor, entitlementsOf, PLAN_KEYS } from '../../domain/account/entitlements.ts'
import { unreviewedLinks } from '../accounts/free-play.ts'
import { adminInbox, loadStanding } from '../accounts/persistence.ts'
import type { Actor } from '../actor.ts'
import { reporterPin } from '../artifacts/reporter.ts'
import { unsentExtra, waitingExtra } from '../billing/extra-usage.ts'
import { unknownOrders } from '../billing/persistence.ts'
import type { CatalogSync } from '../catalog/sync.ts'
import { EDGE_BEHIND_MS, edgesBehind } from '../edge/routed.ts'
import { adminAlert } from '../emails/admins.ts'
import { NotFound } from '../errors.ts'
import { anyOfficialServer } from '../listings/persistence.ts'
import { markedSince } from '../operations/persistence.ts'
import { SPEND_FIGURE, SPEND_UNREAD_MS } from '../operations/schedules/spend.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { Mailer } from '../ports/platform.ts'
import { CERTIFICATE_RENEWAL, CERTIFICATE_WARN_MS, storedAcmeCertificate } from '../realtime/certificate.ts'
import { KEEP_MS, serversKeepingStorage } from '../servers/kept-storage.ts'
import { anyStopCheatersOn } from '../stop-cheaters/persistence.ts'
import { FAILING_IN_A_ROW, overdue, quietSince } from './job-record.ts'
import {
  alertNotified,
  clearAlert,
  type JobHealthRecord,
  loadAlerts,
  loadJobHealth,
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
  edge_behind: '/admin/platform',
  resumes_hung: '/admin/health',
  hosts_refused: '/admin/health',
  storage_kept: '/admin/health',
  jobs_failing: '/admin/health',
  spend_unread: '/admin/platform',
  realtime_certificate_expiring: '/admin/health',
  official_files: '/admin/health',
  stop_cheaters_default: '/admin/health',
  stop_cheaters_no_reporter: '/admin/health',
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
  readonly #officialFilesProblem: 'unset' | 'invalid' | null
  readonly #stopCheatersProblem: 'unset' | 'invalid' | null

  constructor(deps: {
    db: Db
    jobs: JobQueue
    catalog: CatalogSync
    mailer: Mailer
    webOrigin: string
    /** ADMIN_ALERT_EMAILS; empty or absent, every admin's own email. */
    adminInbox?: readonly string[]
    /** Why OFFICIAL_SERVER_FILES gives no files, when it should. */
    officialServerFiles?: { problem: 'unset' | 'invalid' | null } | undefined
    /** Why STOP_CHEATERS gives the public default, where production should have its own. */
    stopCheatersProblem?: 'unset' | 'invalid' | null
  }) {
    this.#db = deps.db
    this.#jobs = deps.jobs
    this.#catalog = deps.catalog
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
    this.#inbox = deps.adminInbox ?? []
    this.#officialFilesProblem = deps.officialServerFiles?.problem ?? null
    this.#stopCheatersProblem = deps.stopCheatersProblem ?? null
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
      if (bytes > entitlementsOf(standing).storage.paidForGb * 2 ** 30) outgrown++
    }
    if (outgrown > 0)
      conditions.push({
        key: 'worlds_outgrow_plan',
        summary: `${outgrown} ${outgrown === 1 ? 'account keeps' : 'accounts keep'} more world data than ${outgrown === 1 ? 'its plan covers' : 'their plans cover'}, and ${outgrown === 1 ? 'costs' : 'cost'} more than ${outgrown === 1 ? 'it pays' : 'they pay'}.`,
      })
    const recorded = await loadJobHealth(this.#db)
    conditions.push(
      ...jobsCondition(recorded, now),
      ...spendCondition(recorded, now),
      ...(await certificateCondition(this.#db, recorded, now)),
      ...(await edgeCondition(this.#db)),
      ...(await wakeConditions(this.#db, now)),
      ...(await unsentCondition(this.#db)),
      ...(await waitingCondition(this.#db, now)),
      ...(await unknownCondition(this.#db)),
      ...(await linkedCondition(this.#db)),
      ...(await officialFilesCondition(this.#db, this.#officialFilesProblem)),
      ...(await stopCheatersCondition(this.#db, this.#stopCheatersProblem)),
      ...(await noReporterCondition(this.#db)),
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

/** A span as an admin reads it: minutes under two hours, then hours. */
const spanOf = (ms: number) =>
  ms < 2 * HOUR_MS ? `${Math.round(ms / MINUTE_MS)} minutes` : `${Math.floor(ms / HOUR_MS)} hours`

/**
 * Scheduled jobs that keep failing, or that have gone three of their intervals without a success
 * (`job-record.ts`). A worker that is down raises nothing here, since this sweep runs on it:
 * `/api/health`, polled from outside, says that.
 */
function jobsCondition(recorded: JobHealthRecord[], now: Date): Condition[] {
  const named = recorded.flatMap((row) => {
    if (row.everySeconds === null) return []
    if (row.failures >= FAILING_IN_A_ROW)
      return [`${row.job} failed ${row.failures} times in a row (${(row.lastError ?? '').slice(0, 160)})`]
    if (overdue(row, now))
      return [`${row.job} hasn't run for ${spanOf(now.getTime() - quietSince(row).getTime())}`]
    return []
  })
  if (named.length === 0) return []
  const one = named.length === 1
  return [
    {
      key: 'jobs_failing',
      summary: `${named.length} scheduled ${one ? 'job is' : 'jobs are'} not getting through: ${named.join('; ')}.`,
    },
  ]
}

/**
 * The spend watchdog unable to work out today's figure for a while (`spend.ts`): nothing holds the
 * daily limit meanwhile. It clears with the next figure.
 */
function spendCondition(recorded: JobHealthRecord[], now: Date): Condition[] {
  const figure = recorded.find((row) => row.job === SPEND_FIGURE)
  if (figure === undefined || figure.failures === 0) return []
  const unread = now.getTime() - quietSince(figure).getTime()
  if (unread < SPEND_UNREAD_MS) return []
  return [
    {
      key: 'spend_unread',
      summary: `The spend watchdog hasn't had a figure for ${spanOf(unread)}, so the daily spend limit isn't enforced until it does. Reading the provider failed with: ${(figure.lastError ?? '').slice(0, 200)}`,
    },
  ]
}

/**
 * The realtime role's certificate a week from lapsing (`realtime/certificate.ts`): its renewals
 * have failed since two thirds of its life, and realtime stops for every browser when it lapses.
 */
async function certificateCondition(db: Db, recorded: JobHealthRecord[], now: Date): Promise<Condition[]> {
  const stored = await storedAcmeCertificate(db)
  if (stored === null || stored.expiresAt.getTime() - now.getTime() > CERTIFICATE_WARN_MS) return []
  const days = Math.max(0, Math.floor((stored.expiresAt.getTime() - now.getTime()) / DAY_MS))
  const renewal = recorded.find((row) => row.job === CERTIFICATE_RENEWAL)
  return [
    {
      key: 'realtime_certificate_expiring',
      summary: `The realtime certificate for ${stored.hostname} lapses in ${days} ${days === 1 ? 'day' : 'days'} and hasn't been renewed; realtime stops for every browser when it does. The last renewal said: ${(renewal?.lastError ?? 'nothing').slice(0, 200)}`,
    },
  ]
}

/** Edges that keep asking for routes without keeping up: servers no longer wait on them. */
async function edgeCondition(db: Db): Promise<Condition[]> {
  const behind = await edgesBehind(db)
  if (behind.length === 0) return []
  const one = behind.length === 1
  return [
    {
      key: 'edge_behind',
      summary: `${one ? 'An edge keeps' : `${behind.length} edges keep`} asking for routes without holding the newest for over ${EDGE_BEHIND_MS / SECOND_MS} s (${behind.join(', ')}). Servers no longer wait on ${one ? 'it' : 'them'}, and players who reach ${one ? 'it' : 'them'} may find no route.`,
    },
  ]
}

/**
 * Wakes in the last day that went wrong on the provider's side, by server. `resumes_hung`: a
 * resume that never came back, so its server was started fresh from its disk (`resume.ts`); each
 * cost a player a cold boot, and several mean the provider's suspend is failing, which switching it
 * off (`platform/suspend-switch.ts`) stops. `hosts_refused`: a server's own host couldn't run it
 * (`handlers/host-refused.ts`); it was rebuilt elsewhere where a sleep's snapshot held all its
 * play, and otherwise its start failed for an admin to decide. `storage_kept`: what such a rebuild
 * kept of the old storage (`servers/kept-storage.ts`), until it goes by itself.
 */
async function wakeConditions(db: Db, now: Date): Promise<Condition[]> {
  const since = new Date(now.getTime() - DAY_MS)
  const [hung, refused, keeping] = [
    await markedSince(db, 'resume_hung', since),
    await markedSince(db, 'host_refused', since),
    await serversKeepingStorage(db),
  ]
  const conditions: Condition[] = []
  const servers = (count: number) => `${count} ${count === 1 ? 'server' : 'servers'}`
  if (hung.newest !== null)
    conditions.push({
      key: 'resumes_hung',
      summary: `${servers(hung.count)} woke in the last day from a resume that never came back, and started fresh from disk instead, with nothing lost. Newest: operation ${hung.newest.operationId} on server ${hung.newest.serverId}.`,
    })
  if (refused.newest !== null)
    conditions.push({
      key: 'hosts_refused',
      summary: `${servers(refused.count)} found their own host unable to run them in the last day. Where a sleep's snapshot held all its play the server was rebuilt elsewhere; otherwise its start failed, for an admin to move it. Newest: operation ${refused.newest.operationId} on server ${refused.newest.serverId}.`,
    })
  if (keeping.length > 0)
    conditions.push({
      key: 'storage_kept',
      summary: `${servers(keeping.length)} keep the storage a rebuild moved them off, a full copy of the world, for ${KEEP_MS / DAY_MS} days before it goes by itself, and don't rest until then (${keeping.join(', ')}).`,
    })
  return conditions
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

/**
 * Servers flagged official starting with the public defaults, because the files private
 * configuration places on them are unset or don't parse (`servers/own-files.ts`). Unset only counts
 * once a server is flagged.
 */
async function officialFilesCondition(db: Db, problem: 'unset' | 'invalid' | null): Promise<Condition[]> {
  if (problem === null) return []
  if (problem === 'unset' && !(await anyOfficialServer(db))) return []
  return [
    {
      key: 'official_files',
      summary: `OFFICIAL_SERVER_FILES is ${problem === 'unset' ? 'not set' : 'not a JSON object of sections (`*`, or a server id or slug) of file paths to contents'}, so servers flagged official start without their own files. Servers still start; set it and they have the files at their next start.`,
    },
  ]
}

/**
 * Servers with Stop cheaters on running the public default, which only alerts and logs, because
 * STOP_CHEATERS is unset or doesn't parse (`app/stop-cheaters/`). Only while any server has it on.
 */
async function stopCheatersCondition(db: Db, problem: 'unset' | 'invalid' | null): Promise<Condition[]> {
  if (problem === null || !(await anyStopCheatersOn(db))) return []
  return [
    {
      key: 'stop_cheaters_default',
      summary: `STOP_CHEATERS is ${problem === 'unset' ? 'not set' : 'not a JSON object of punishments and a ban rule'}, so servers with Stop cheaters on start with the public default, which only alerts and logs. Servers still start; set it and they have it at their next start.`,
    },
  ]
}

/**
 * Servers running Stop cheaters while the join reporter isn't stored yet (`artifacts/reporter.ts`):
 * every removal goes through its `cubepals-remove`, so their starts write the public default, alerts
 * and logs only, rather than a file that would remove nobody (`stop-cheaters/start.ts`).
 */
async function noReporterCondition(db: Db): Promise<Condition[]> {
  if ((await reporterPin(db)) !== null || !(await anyStopCheatersOn(db))) return []
  return [
    {
      key: 'stop_cheaters_no_reporter',
      summary:
        'The join reporter isn’t stored, so servers with Stop cheaters on can’t remove anyone: their starts write the public default, which only alerts and logs. It is stored as the control plane starts, given an archive store; once it is, they have it at their next start.',
    },
  ]
}

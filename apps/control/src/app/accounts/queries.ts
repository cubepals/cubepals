// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { AccountOverviewView, PartySize, PublicPlan, PublicSize } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import {
  type Entitlements,
  EXTRA_CHOICES,
  entitlementsFor,
  PAID_PLANS,
  PLAN_KEYS,
  planName,
} from '../../domain/account/entitlements.ts'
import { ceilingsFor } from '../../domain/account/extra-play.ts'
import { METER_UNITS, UNIT_CENTS } from '../../domain/account/meter.ts'
import { DEFAULT_TIME_ZONE, monthStart } from '../../domain/account/play-day.ts'
import type { AccountStanding } from '../../domain/account/standing.ts'
import type { Capability, DenialCode } from '../../domain/policy/policy.ts'
import { type MemoryTier, memoryMb, PARTY, playerCapacity, sizeLabel } from '../../domain/server/size.ts'
import { type Actor, runsThePlatform } from '../actor.ts'
import { settleable } from '../billing/balance.ts'
import { meteredMonth, meteredUnitsSince } from '../billing/chip-in-meter.ts'
import { type EndedFor, endedFor } from '../billing/ending.ts'
import { extraThisMonth } from '../billing/extra-usage.ts'
import { giftNext } from '../billing/gifts.ts'
import { extraPlayNow, giftedPlan, latestSubscription, PAST_DUE_GRACE_MS } from '../billing/persistence.ts'
import { yearView } from '../billing/years.ts'
import { NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import { listUnpurged } from '../servers/persistence.ts'
import { tuning } from '../tuning.ts'
import {
  type AccountRow,
  countServers,
  isAdmin,
  loadStanding,
  runHoursSince,
  searchAccounts,
} from './persistence.ts'
import type { PlayMonth } from './play-month.ts'
import { playToday } from './play-today.ts'
import { type PlayTotal, playTotal } from './play-total.ts'

/** Play is shown to one decimal: enough to see it move, not so much that it reads as a bill. */
const round = (value: number): number => Math.round(value * 10) / 10

/** The play in all as the account page shows it, to a tenth like the rest. */
const totalSaid = (total: PlayTotal | null): AccountOverviewView['usage']['total'] =>
  total === null ? null : { units: round(total.units), included: total.included }

/** The plan with this month's block: hours lowered mid-month apply from the next (`meteredMonth`). */
const monthsBlock = (entitlements: Entitlements, month: PlayMonth | null): Entitlements =>
  month === null ? entitlements : { ...entitlements, includedUnits: month.included }

/** A time zone the browser reported that takes over next month, as the account page says it. */
const zoneWaiting = (
  standing: Pick<AccountStanding, 'nextTimeZone' | 'nextTimeZoneFrom'>,
): AccountOverviewView['usage']['nextTimeZone'] =>
  standing.nextTimeZone === null || standing.nextTimeZoneFrom === null
    ? null
    : { zone: standing.nextTimeZone, from: standing.nextTimeZoneFrom.toISOString() }

/** Features an account page lists, each answered by the policy as the API would answer it. */
const FEATURES = [
  'create_server',
  'create_archive',
  'restore_archive',
  'upload_mod',
  'list_publicly',
  'console_command',
  'billing',
] as const
type Feature = (typeof FEATURES)[number]

export interface AccountOverview {
  standing: Pick<AccountStanding, 'status' | 'reason'>
  plan: {
    key: string
    /**
     * What the billing provider says, when a subscription pays for the plan or once did.
     * `pastDueUntil`: its renewal failed to charge, and the plan lasts until then unless the card
     * is fixed. `endedFor`: Blockly ended it itself, after a withdrawal or a renewal left unpaid.
     */
    billed: {
      status: string
      periodEnd: Date | null
      cancelAtPeriodEnd: boolean
      planKey: string
      pastDueUntil: Date | null
      endedFor: EndedFor | null
      /** A smaller plan it moves to at the end of the period paid for; null: it stays. */
      movesTo: { plan: string; at: Date } | null
    } | null
    /**
     * The plan paid for a year at once: when the first year still to run starts, when the last
     * ends, and whether another is paid for after the first (a renewal). Null with none to run.
     */
    year: { planKey: string; startsAt: Date; endsAt: Date; renewed: boolean } | null
    /** A redeemed gift that gives the plan now, and when the gifted time runs out. */
    gifted: { planKey: string; until: Date } | null
    /**
     * A redeemed gift waiting to start, once the time the account has paid for ends; `continues`
     * when part of it ran already, and what is left of it runs then.
     */
    giftNext: { planKey: string; months: number; startsAt: Date; endsAt: Date; continues: boolean } | null
  }
  entitlements: Entitlements
  /** The sizes the plan allows, as somebody reads them: "3 GB · up to 5 players". */
  sizeLabels: string[]
  settings: { afkKickMinutes: number | null }
  usage: {
    servers: number
    running: number
    today: AccountOverviewView['usage']['today']
    total: AccountOverviewView['usage']['total']
    unitsThisMonth: number
    hoursThisMonth: number
    /** What was left of last month's block and carried into this one, up to the plan's `carryUnits`, in units. */
    carriedUnits: number
    monthBegan: AccountOverviewView['usage']['monthBegan']
    timeZone: AccountOverviewView['usage']['timeZone']
    nextTimeZone: AccountOverviewView['usage']['nextTimeZone']
    extraUnitsAllowed: number
    unitCents: number
    /**
     * Extra play: whether the account may allow any now, and if not why, in one sentence; the most
     * it may allow and the limits it picks from; what it has run up this month, in units, and of
     * that what was sent to be billed; and what it owes from a payment that didn't go through.
     */
    extra: {
      may: boolean
      why: string | null
      ceiling: number
      /** The ceiling once a renewal is paid, while it is higher than today's; null otherwise. */
      nextCeiling: number | null
      choices: number[]
      countedUnits: number
      reportedUnits: number
      owedCents: number
      /** Of that, what is paid as a balance (`billing.settle`); the rest by fixing the card. */
      settleCents: number
    }
  }
  features: Array<{ feature: Feature; available: boolean; code?: DenialCode; message?: string }>
  /** Every plan, for comparing and upgrading. */
  plans: Array<{ key: string; entitlements: Entitlements; sizeLabels: string[] }>
}

/**
 * A size as somebody reads it. The gigabytes stay, because that is what the plan sells, but the
 * part that decides anything — how many can play on it — is said out loud beside them.
 */
const sizeAndParty = (tier: MemoryTier): string =>
  `${sizeLabel(tier)} · up to ${playerCapacity(tier)} players`

export interface Me {
  userId: string
  name: string
  email: string
  admin: boolean
  standing: Pick<AccountStanding, 'status' | 'reason' | 'plan'>
  timeZone: string | null
}

export type { AccountRow }

export interface AccountDetail extends AccountRow {
  /**
   * Until when the plan in force is known to hold, as `planFrom` says it: a subscription's paid
   * period (or its grace, past due), a year's end, a gift's; null for one an admin set, or Free.
   * `planRenews`: a subscription that pays and isn't set to end.
   */
  planUntil: Date | null
  planRenews: boolean
  plans: string[]
  serverList: Array<{ id: string; name: string; slug: string; status: string; deleted: boolean }>
  /** What admins and the platform did to the account, newest first. */
  history: Array<{ at: Date; actor: string; action: string; data: Record<string, unknown> }>
}

/** Accounts as their owners and admins see them. */
export class AccountQueries {
  readonly #db: Db
  readonly #policy: AccessPolicy

  constructor(deps: { db: Db; policy: AccessPolicy }) {
    this.#db = deps.db
    this.#policy = deps.policy
  }

  /**
   * The signed-in person's plan, what it allows, what they use of it, and each feature as the
   * policy answers it now: the same function the API enforces with, run without its lock.
   */
  async overview(actor: Actor, now = new Date()): Promise<AccountOverview> {
    if (actor.kind === 'system' || actor.kind === 'operator') throw new NotFound('Account')
    const userId = actor.userId
    const standing = await loadStanding(this.#db, userId, now)
    const entitlements = entitlementsFor(standing.plan, standing.limitOverrides)
    const owned = await countServers(this.#db, userId)
    const month = await meteredMonth(this.#db, standing, entitlements, now)
    const zone = standing.timeZone ?? DEFAULT_TIME_ZONE
    const monthBegan = month?.start ?? monthStart(now, zone)
    const subscription = await latestSubscription(this.#db, userId)
    const gifted = await giftedPlan(this.#db, userId, now)
    const { decision, owedCents } = await extraPlayNow(this.#db, standing)
    const ceiling = decision.may ? decision.ceiling : 0
    const today = await playToday(this.#db, standing, entitlements, now)
    const total = await playTotal(this.#db, standing, entitlements, now)
    const capability = (feature: Feature): Capability =>
      feature === 'create_server'
        ? { kind: 'create_server', memoryTier: entitlements.allowedMemoryTiers[0] ?? '2g' }
        : { kind: feature }
    const features = await this.#db.transaction(async (tx) => {
      const answers: AccountOverview['features'] = []
      for (const feature of FEATURES) {
        const decision = await this.#policy.check(tx, userId, capability(feature), now, { lock: false })
        answers.push(
          decision.ok
            ? { feature, available: true }
            : { feature, available: false, code: decision.code, message: decision.message },
        )
      }
      return answers
    })
    return {
      standing: { status: standing.status, reason: standing.reason },
      plan: {
        key: standing.plan,
        billed:
          subscription === null
            ? null
            : {
                status: subscription.status,
                periodEnd: subscription.currentPeriodEnd,
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                planKey: subscription.planKey,
                pastDueUntil:
                  subscription.status === 'past_due' && subscription.pastDueAt !== null
                    ? new Date(subscription.pastDueAt.getTime() + PAST_DUE_GRACE_MS)
                    : null,
                endedFor: await endedFor(this.#db, subscription),
                movesTo: movesOf(subscription),
              },
        year: await yearView(this.#db, userId, now),
        gifted,
        giftNext: await giftNext(this.#db, userId, now),
      },
      entitlements: monthsBlock(entitlements, month),
      settings: { afkKickMinutes: standing.afkKickMinutes },
      usage: {
        servers: owned.servers,
        running: owned.running,
        today:
          today === null
            ? null
            : { units: round(today.units), included: today.included, backAt: today.backAt.toISOString() },
        total: totalSaid(total),
        unitsThisMonth: round(await meteredUnitsSince(this.#db, userId, monthBegan, now)),
        hoursThisMonth: round(await runHoursSince(this.#db, userId, monthBegan, now)),
        carriedUnits: round(month?.carried ?? 0),
        monthBegan: monthBegan.toISOString(),
        timeZone: zone,
        nextTimeZone: zoneWaiting(standing),
        extraUnitsAllowed: standing.extraUnitsAllowed,
        unitCents: UNIT_CENTS,
        extra: {
          may: decision.may,
          why: decision.may ? null : decision.why,
          ceiling,
          nextCeiling:
            decision.may && ceiling < ceilingsFor(entitlements, tuning().abuse.extraCeiling).renewed
              ? ceilingsFor(entitlements, tuning().abuse.extraCeiling).renewed
              : null,
          choices: decision.may ? EXTRA_CHOICES.filter((units) => units <= ceiling) : [],
          ...(await extraThisMonth(this.#db, standing, now)),
          owedCents,
          settleCents: (await settleable(this.#db, userId)).totalCents,
        },
      },
      features,
      sizeLabels: entitlements.allowedMemoryTiers.map(sizeAndParty),
      plans: ['free', ...PAID_PLANS].map((key) => {
        const plan = entitlementsFor(key)
        return { key, entitlements: plan, sizeLabels: plan.allowedMemoryTiers.map(sizeAndParty) }
      }),
    }
  }

  /** The signed-in person: who they are, whether they administer, and their standing. */
  async me(actor: Actor): Promise<Me> {
    if (actor.kind === 'system' || actor.kind === 'operator') throw new NotFound('Account')
    const [user] = await this.#db.select().from(schema.users).where(eq(schema.users.id, actor.userId))
    if (!user) throw new NotFound('Account')
    const standing = await loadStanding(this.#db, user.id)
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      admin: await isAdmin(this.#db, user.id),
      standing: { status: standing.status, reason: standing.reason, plan: standing.plan },
      // What the browser last said, waiting or not, so it isn't said again.
      timeZone: standing.nextTimeZone ?? standing.timeZone,
    }
  }

  async list(
    actor: Actor,
    query: { search: string; offset: number; limit: number },
  ): Promise<{ accounts: AccountRow[]; total: number }> {
    if (!runsThePlatform(actor)) throw new NotFound('Account')
    const { rows, total } = await searchAccounts(this.#db, query.search, query.offset, query.limit)
    return { accounts: rows, total }
  }

  async get(actor: Actor, userId: string): Promise<AccountDetail> {
    if (!runsThePlatform(actor)) throw new NotFound('Account')
    const [user] = await this.#db.select().from(schema.users).where(eq(schema.users.id, userId))
    if (!user) throw new NotFound('Account')
    const { rows } = await searchAccounts(this.#db, user.email, 0, 1)
    const row = rows.find((r) => r.userId === userId)
    if (!row) throw new NotFound('Account')
    const until = await this.#planUntil(row, new Date())
    const servers = await listUnpurged(this.#db, userId)
    const history = await this.#db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, 'account'), eq(schema.auditLog.subjectId, userId)))
      .orderBy(desc(schema.auditLog.at))
      .limit(50)
    return {
      ...row,
      ...until,
      plans: ['free', ...PAID_PLANS],
      serverList: servers.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        status: s.lifecycle.status,
        deleted: s.deletedAt !== null,
      })),
      history: history.map((h) => ({
        at: h.at,
        actor: h.actor,
        action: h.action,
        data: h.data,
      })),
    }
  }

  /** `AccountDetail.planUntil` and `planRenews`, from what gives the plan in force. */
  async #planUntil(row: AccountRow, now: Date): Promise<Pick<AccountDetail, 'planUntil' | 'planRenews'>> {
    if (row.planFrom === 'subscription') {
      const subscription = await latestSubscription(this.#db, row.userId)
      if (subscription?.status === 'past_due' && subscription.pastDueAt !== null)
        return {
          planUntil: new Date(subscription.pastDueAt.getTime() + PAST_DUE_GRACE_MS),
          planRenews: false,
        }
      return {
        planUntil: subscription?.currentPeriodEnd ?? null,
        planRenews: subscription?.cancelAtPeriodEnd === false,
      }
    }
    if (row.planFrom === 'year')
      return { planUntil: (await yearView(this.#db, row.userId, now))?.endsAt ?? null, planRenews: false }
    if (row.planFrom === 'gift')
      return { planUntil: (await giftedPlan(this.#db, row.userId, now))?.until ?? null, planRenews: false }
    return { planUntil: null, planRenews: false }
  }
}

/** The smaller plan a subscription moves to at the end of its period, and when; null if it stays. */
const movesOf = (s: { movesToPlan: string | null; movesAt: Date | null }) =>
  s.movesToPlan !== null && s.movesAt !== null ? { plan: s.movesToPlan, at: s.movesAt } : null

/**
 * Every plan as the pricing page shows it, from the plan table itself: the page reads
 * this rather than keeping numbers of its own that could drift from what is enforced.
 */
export function publicPlans(sold: { unsoldPlans: readonly string[] }): PublicPlan[] {
  return PLAN_KEYS.map((key) => {
    const plan = entitlementsFor(key)
    const largest = Math.max(...plan.allowedMemoryTiers.map(playerCapacity))
    const players = (tier: MemoryTier) =>
      plan.settingCaps === null
        ? playerCapacity(tier)
        : Math.min(playerCapacity(tier), plan.settingCaps.maxPlayers)
    return {
      key,
      name: planName(key),
      monthlyPriceCents: plan.monthlyPriceCents,
      yearlyPriceCents: plan.yearlyPriceCents,
      includedHours: plan.dailyUnits ?? plan.includedUnits ?? 0,
      per: plan.dailyUnits === null ? 'month' : 'day',
      extraHourCents: plan.mayBuyMore ? UNIT_CENTS : null,
      totalHours: plan.totalUnits,
      sleepsAfterMinutes: plan.idleShutdownAfterMinutes,
      maxServers: plan.maxServers,
      maxPlayers: plan.settingCaps === null ? largest : Math.min(largest, plan.settingCaps.maxPlayers),
      sizes: [...plan.allowedMemoryTiers]
        .sort((a, b) => memoryMb(a) - memoryMb(b))
        .map((tier) => ({
          gb: memoryMb(tier) / 1024,
          maxPlayers: players(tier),
          hoursAnHour: METER_UNITS[tier],
        })),
      available: !sold.unsoldPlans.includes(key),
      mods: plan.mayUseMods,
      datapacks: plan.mayUseDatapacks,
      downloads: plan.backupPolicy.archiveEnabled ? 'history' : 'daily',
      sessionsKept: plan.backupPolicy.snapshotsKept,
      restsAfterDays: plan.storeAfterIdleDays,
      deletedAfterDays: plan.deleteAfterIdleDays,
    }
  })
}

/**
 * The size behind each answer to "Who is playing?", from the table servers are made with, for the
 * guide that shows what Cubepals runs: its memory, below the fold, as the owner allowed.
 */
export function publicSizes(): PublicSize[] {
  return (Object.keys(PARTY) as PartySize[]).map((party) => ({
    party,
    maxPlayers: PARTY[party].maxPlayers,
    memory: sizeLabel(PARTY[party].tier),
  }))
}

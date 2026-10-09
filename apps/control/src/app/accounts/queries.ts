import type { PartySize, PublicPlan, PublicSize } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import {
  type Entitlements,
  EXTRA_CEILING,
  EXTRA_CHOICES,
  entitlementsFor,
  PAID_PLANS,
  PLAN_KEYS,
  planName,
} from '../../domain/account/entitlements.ts'
import { UNIT_CENTS } from '../../domain/account/meter.ts'
import type { AccountStanding } from '../../domain/account/standing.ts'
import type { Capability, DenialCode } from '../../domain/policy/policy.ts'
import { type MemoryTier, PARTY, playerCapacity, sizeLabel } from '../../domain/server/size.ts'
import type { Actor } from '../actor.ts'
import { extraThisMonth } from '../billing/extra-usage.ts'
import { extraPlayNow, latestSubscription, PAST_DUE_GRACE_MS } from '../billing/persistence.ts'
import { NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import { listUnpurged } from '../servers/persistence.ts'
import {
  type AccountRow,
  countServers,
  isAdmin,
  loadStanding,
  runHoursSince,
  runUnitsSince,
  searchAccounts,
} from './persistence.ts'

/** Play is shown to one decimal: enough to see it move, not so much that it reads as a bill. */
const round = (value: number): number => Math.round(value * 10) / 10

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
     * is fixed.
     */
    billed: {
      status: string
      periodEnd: Date | null
      cancelAtPeriodEnd: boolean
      planKey: string
      pastDueUntil: Date | null
    } | null
  }
  entitlements: Entitlements
  /** The sizes the plan allows, as somebody reads them: "3 GB · up to 5 players". */
  sizeLabels: string[]
  settings: { afkKickMinutes: number | null }
  usage: {
    servers: number
    running: number
    unitsThisMonth: number
    hoursThisMonth: number
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
}

export type { AccountRow }

export interface AccountDetail extends AccountRow {
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
    if (actor.kind === 'system') throw new NotFound('Account')
    const userId = actor.userId
    const standing = await loadStanding(this.#db, userId, now)
    const entitlements = entitlementsFor(standing.plan, standing.limitOverrides)
    const owned = await countServers(this.#db, userId)
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const subscription = await latestSubscription(this.#db, userId)
    const { decision, owedCents } = await extraPlayNow(this.#db, standing, now)
    const ceiling = decision.may ? decision.ceiling : 0
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
              },
      },
      entitlements,
      settings: { afkKickMinutes: standing.afkKickMinutes },
      usage: {
        servers: owned.servers,
        running: owned.running,
        unitsThisMonth: round(await runUnitsSince(this.#db, userId, monthStart, now)),
        hoursThisMonth: round(await runHoursSince(this.#db, userId, monthStart, now)),
        extraUnitsAllowed: standing.extraUnitsAllowed,
        unitCents: UNIT_CENTS,
        extra: {
          may: decision.may,
          why: decision.may ? null : decision.why,
          ceiling,
          nextCeiling: decision.may && ceiling < EXTRA_CEILING.renewed ? EXTRA_CEILING.renewed : null,
          choices: decision.may ? EXTRA_CHOICES.filter((units) => units <= ceiling) : [],
          ...(await extraThisMonth(this.#db, userId, now)),
          owedCents,
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
    if (actor.kind === 'system') throw new NotFound('Account')
    const [user] = await this.#db.select().from(schema.users).where(eq(schema.users.id, actor.userId))
    if (!user) throw new NotFound('Account')
    const standing = await loadStanding(this.#db, user.id)
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      admin: await isAdmin(this.#db, user.id),
      standing: { status: standing.status, reason: standing.reason, plan: standing.plan },
    }
  }

  async list(
    actor: Actor,
    query: { search: string; offset: number; limit: number },
  ): Promise<{ accounts: AccountRow[]; total: number }> {
    if (actor.kind !== 'admin') throw new NotFound('Account')
    const { rows, total } = await searchAccounts(this.#db, query.search, query.offset, query.limit)
    return { accounts: rows, total }
  }

  async get(actor: Actor, userId: string): Promise<AccountDetail> {
    if (actor.kind !== 'admin') throw new NotFound('Account')
    const [user] = await this.#db.select().from(schema.users).where(eq(schema.users.id, userId))
    if (!user) throw new NotFound('Account')
    const { rows } = await searchAccounts(this.#db, user.email, 0, 1)
    const row = rows.find((r) => r.userId === userId)
    if (!row) throw new NotFound('Account')
    const servers = await listUnpurged(this.#db, userId)
    const history = await this.#db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, 'account'), eq(schema.auditLog.subjectId, userId)))
      .orderBy(desc(schema.auditLog.at))
      .limit(50)
    return {
      ...row,
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
}

/**
 * Every plan as the pricing page shows it, from the plan table itself: the page reads
 * this rather than keeping numbers of its own that could drift from what is enforced.
 */
export function publicPlans(): PublicPlan[] {
  return PLAN_KEYS.map((key) => {
    const plan = entitlementsFor(key)
    const largest = Math.max(...plan.allowedMemoryTiers.map(playerCapacity))
    return {
      key,
      name: planName(key),
      monthlyPriceCents: plan.monthlyPriceCents,
      includedHours: plan.includedUnits ?? 0,
      sleepsAfterMinutes: plan.idleShutdownAfterMinutes,
      maxServers: plan.maxServers,
      maxPlayers: plan.settingCaps === null ? largest : Math.min(largest, plan.settingCaps.maxPlayers),
      mods: plan.mayUseMods,
      downloads: plan.backupPolicy.archiveEnabled ? 'history' : 'daily',
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

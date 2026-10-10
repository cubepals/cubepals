import type { SignUpAgreement, SignupSource } from '@blockly/contracts'
import { type Db, schema, type Tx } from '@blockly/db'
import {
  type Entitlements,
  EXTRA_CEILING,
  entitlementsFor,
  PAID_PLANS,
  planGap,
} from '../../domain/account/entitlements.ts'
import { extraUnits } from '../../domain/account/extra-play.ts'
import type { Restrictions } from '../../domain/account/standing.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { extraPlayNow } from '../billing/persistence.ts'
import { playWarning } from '../emails/play.ts'
import { AppError, NotFound } from '../errors.ts'
import { forgetAccount } from '../guestbook/persistence.ts'
import { FUNNEL, noteOnce } from '../insight/record.ts'
import { listingsOfOwner } from '../listings/persistence.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { Mailer } from '../ports/platform.ts'
import { runsOf } from '../revisions/caps.ts'
import { listOwned, listUnpurged, loadRevision } from '../servers/persistence.ts'
import type { MinecraftServerService } from '../servers/service.ts'
import { openIntervalStart } from '../servers/usage.ts'
import { warnAboutExtra } from './extra-play.ts'
import {
  countTakenFreePlaces,
  emailOf,
  ensureStanding,
  grantAdmin,
  holdFreePlace,
  isAdmin,
  joinWaitlist,
  listAdmins,
  loadControls,
  loadStanding,
  lockAccountActions,
  lockFreePlaces,
  lockStanding,
  ownersNotActive,
  ownersRunning,
  recordSignupSource,
  revokeAdmin,
  runUnitsSince,
  saveStanding,
  verifiedByEmail,
} from './persistence.ts'

/** Plans an admin can put an account on: the paid ones, and free. */
const PLANS = new Set(['free', ...PAID_PLANS])

/** Servers that hold compute a suspended account shouldn't keep running. */
const RUNNING = new Set(['starting', 'running'])

/** A link's campaign tags past its source (`utm_medium`…); a link that named only a source has none. */
type CampaignTags = Omit<SignupSource, 'source'>
const NO_TAGS: CampaignTags = { medium: null, campaign: null, content: null, term: null }

/** Waitlist addresses taken a minute before it waits: people type one address, scripts many. */
const WAITLIST_PER_MINUTE = 30

/**
 * Where this month's play is worth saying something about, in per cent of the included block.
 * Half is a note, four fifths is a warning with the number of hours left, and all of it is the
 * moment servers go to sleep. Later ones say what the earlier ones did, so a warning that
 * arrives late still makes sense on its own.
 */
const WARN_AT = [50, 80, 100] as const

/**
 * Account standing, as admins set it (§4). Suspension stops what the account
 * runs and denies it everything but looking; termination closes its servers for good. Every
 * change is audited. Only admin actors reach these methods.
 *
 * It also watches what an account's play costs it, and says so before the money does.
 */
export class AccountService {
  readonly #db: Db
  readonly #servers: MinecraftServerService
  readonly #jobs: JobQueue
  readonly #mailer: Mailer
  readonly #webOrigin: string
  /** Verified emails that are admins by configuration. */
  readonly #configured: readonly string[]
  /** Whether sign-up stops at `maxFreeAccounts`: everywhere but local development. */
  readonly #capped: boolean
  /** When each recent waitlist address came in, for the minute's count. */
  #waitlisted: number[] = []

  constructor(deps: {
    db: Db
    servers: MinecraftServerService
    jobs: JobQueue
    mailer: Mailer
    webOrigin: string
    /** What configuration says: the admins it lists, and whether sign-up stops at the cap. */
    configured: { admins: readonly string[]; signupCap: boolean }
  }) {
    this.#db = deps.db
    this.#servers = deps.servers
    this.#jobs = deps.jobs
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
    this.#configured = deps.configured.admins.map((email) => email.toLowerCase())
    this.#capped = deps.configured.signupCap
  }

  async suspend(actor: Actor, userId: string, reason: string): Promise<void> {
    const why = reason.trim()
    if (why.length === 0) throw new AppError('invalid_choice', 'Say why the account is suspended.')
    await this.#change(actor, userId, 'account.suspended', { reason: why }, async (tx, standing) => {
      if (standing.status === 'terminated')
        throw new AppError('invalid_transition', 'A terminated account stays terminated.')
      await saveStanding(tx, userId, { status: 'suspended', reason: why })
    })
    await this.stopServersOf(userId)
  }

  /** Back to active. Stopped servers stay stopped until their owner starts them. */
  async reinstate(actor: Actor, userId: string): Promise<void> {
    await this.#change(actor, userId, 'account.reinstated', {}, async (tx, standing) => {
      if (standing.status === 'terminated')
        throw new AppError('invalid_transition', 'A terminated account stays terminated.')
      await saveStanding(tx, userId, { status: 'active', reason: null })
    })
  }

  /** Closed for good: every server is deleted and purged at the next sweep. */
  async terminate(actor: Actor, userId: string, reason: string): Promise<void> {
    const why = reason.trim()
    if (why.length === 0) throw new AppError('invalid_choice', 'Say why the account is closed.')
    await this.#change(actor, userId, 'account.terminated', { reason: why }, async (tx) => {
      // A star or note being written right now finishes first, and goes below; a later one waits
      // and finds the account closed.
      await lockAccountActions(tx, userId)
      await saveStanding(tx, userId, { status: 'terminated', reason: why })
      // What it wrote on other people's servers goes with it, and so do its stars.
      await forgetAccount(tx, userId)
    })
    await this.closeServersOf(userId)
  }

  async setRestrictions(actor: Actor, userId: string, restrictions: Restrictions): Promise<void> {
    const set: Restrictions = {
      ...(restrictions.provisioning ? { provisioning: true } : {}),
      ...(restrictions.publicListing ? { publicListing: true } : {}),
      ...(restrictions.consoleCommands ? { consoleCommands: true } : {}),
    }
    await this.#change(actor, userId, 'account.restricted', { restrictions: set }, (tx) =>
      saveStanding(tx, userId, { restrictions: set }),
    )
  }

  /**
   * The plan an account is on, set by hand: self-hosted deployments have no billing to set it,
   * and hosted ones can comp an account (a billing sync may later change it again).
   */
  async setPlan(actor: Actor, userId: string, plan: string): Promise<void> {
    if (!PLANS.has(plan)) throw new AppError('invalid_choice', `There is no ${plan} plan.`)
    await this.#change(actor, userId, 'account.plan_set', { plan }, (tx) =>
      saveStanding(tx, userId, { plan }),
    )
  }

  /**
   * How much play past the plan's included block the owner allows themselves to be charged for
   * (§15.5), billed on their next payment. It is theirs to set and nobody else's: Blockly never
   * spends past it, so the answer to "will this surprise me" is always no. Only an account extra
   * play's guards let (`domain/account/extra-play.ts`) may allow any, up to its ceiling; zero,
   * where every account starts, is always allowed, and means servers sleep when the block runs out.
   */
  async allowExtraPlay(actor: Actor, units: number): Promise<number> {
    if (actor.kind !== 'user') throw new NotFound('Account')
    if (!Number.isInteger(units) || units < 0)
      throw new AppError('invalid_choice', 'Allow a whole number of hours of extra play, or none.')
    const standing = await loadStanding(this.#db, actor.userId)
    if (units > 0) {
      const { decision } = await extraPlayNow(this.#db, standing)
      if (!decision.may) throw new AppError('not_entitled', decision.why)
      if (units > decision.ceiling)
        throw new AppError(
          'invalid_choice',
          decision.ceiling < EXTRA_CEILING.renewed
            ? `You can allow up to ${decision.ceiling} extra hours a month until your first renewal is paid, then up to ${EXTRA_CEILING.renewed}.`
            : `You can allow up to ${decision.ceiling} extra hours a month.`,
        )
    }
    await this.#db.transaction(async (tx) => {
      const locked = await lockStanding(tx, actor.userId)
      if (locked === null) throw new NotFound('Account')
      await saveStanding(tx, actor.userId, { extraUnitsAllowed: units })
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'account.extra_play_allowed',
        subjectType: 'account',
        subjectId: actor.userId,
        data: { units },
      })
    })
    // A start refused at the end of the hours is the owner's to try again; one lowered stops now.
    await this.enforceLimits(actor.userId)
    return units
  }

  /**
   * The AFK kick, where the plan lets its owner choose one. Null goes back to the plan's own, and
   * 0 is never. A plan whose play is metered is one where an idle player costs money, which is
   * why the choice exists at all; a plan with a fixed allowance keeps Blockly's number.
   */
  async setAfkKick(actor: Actor, minutes: number | null): Promise<number | null> {
    if (actor.kind !== 'user') throw new NotFound('Account')
    if (minutes !== null && minutes !== 0 && (!Number.isInteger(minutes) || minutes < 5 || minutes > 120))
      throw new AppError('invalid_choice', 'An AFK kick is between 5 and 120 minutes, or never.')
    const standing = await loadStanding(this.#db, actor.userId)
    if (!entitlementsFor(standing.plan, standing.limitOverrides).mayChooseAfkKick)
      throw new AppError('not_entitled', 'Your plan keeps Cubepals’ own AFK kick. Plus lets you set it.')
    await this.#db.transaction(async (tx) => {
      const locked = await lockStanding(tx, actor.userId)
      if (locked === null) throw new NotFound('Account')
      await saveStanding(tx, actor.userId, { afkKickMinutes: minutes })
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'account.afk_kick_set',
        subjectType: 'account',
        subjectId: actor.userId,
        data: { minutes },
      })
    })
    return minutes
  }

  /**
   * Where the account came from, as the link that brought it said: kept once, in the
   * week after sign-up, and never overwritten. Saying it again does nothing.
   */
  async recordSource(actor: Actor, source: string, tags: CampaignTags = NO_TAGS): Promise<void> {
    if (actor.kind !== 'user') throw new NotFound('Account')
    await recordSignupSource(this.#db, actor.userId, { source, ...tags })
  }

  /**
   * Limits above or below the plan's, for this account only; null returns to the plan's. Hours of
   * play a month (`includedUnits`) are given the same way: to make up for a bad month, or to test.
   */
  async setLimits(
    actor: Actor,
    userId: string,
    limits: { maxServers: number | null; maxRunning: number | null; includedUnits?: number | null },
  ): Promise<void> {
    for (const value of [limits.maxServers, limits.maxRunning])
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1000))
        throw new AppError('invalid_choice', 'Limits are whole numbers from 0 to 1000.')
    const hours = limits.includedUnits ?? null
    if (hours !== null && (!Number.isInteger(hours) || hours < 0 || hours > 10_000))
      throw new AppError('invalid_choice', 'Hours of play are a whole number from 0 to 10,000.')
    const overrides = {
      ...(limits.maxServers === null ? {} : { maxServers: limits.maxServers }),
      ...(limits.maxRunning === null ? {} : { maxRunning: limits.maxRunning }),
      ...(hours === null ? {} : { includedUnits: hours }),
    }
    await this.#change(actor, userId, 'account.limits_set', { limits: overrides }, (tx) =>
      saveStanding(tx, userId, { limitOverrides: overrides }),
    )
  }

  async grantAdmin(actor: Actor, userId: string): Promise<void> {
    await this.#change(actor, userId, 'account.admin_granted', {}, async (tx) => {
      await grantAdmin(tx, userId, requestedBy(actor))
    })
  }

  /** The last admin stays: someone must be able to grant it again. */
  async revokeAdmin(actor: Actor, userId: string): Promise<void> {
    await this.#change(actor, userId, 'account.admin_revoked', {}, async (tx) => {
      const all = await listAdmins(tx)
      if (!all.some((a) => a.userId === userId)) return
      if (all.length === 1)
        throw new AppError('invalid_choice', 'This is the last admin; grant another first.')
      await revokeAdmin(tx, userId)
    })
  }

  /**
   * Admins from configuration: every account with a confirmed email in ADMIN_EMAILS is one, and
   * one that was an admin only because it was listed stops being one when it no longer is.
   */
  async bootstrapAdmins(): Promise<void> {
    await this.#db.transaction(async (tx) => {
      for (const userId of await verifiedByEmail(tx, this.#configured)) await grantAdmin(tx, userId, 'config')
      for (const admin of await listAdmins(tx))
        if (admin.grantedBy === 'config' && !this.#configured.includes(admin.email.toLowerCase()))
          await revokeAdmin(tx, admin.userId)
    })
  }

  /**
   * Whether sign-up has room for another free account (docs/money-guards.md): the platform holds
   * them to `maxFreeAccounts`, an admin's number, counting places held for sign-ups in flight.
   * What the sign-up page asks before it shows the form; `admits` is what decides.
   * Local development has no cap.
   */
  async signupsOpen(): Promise<boolean> {
    if (!this.#capped) return true
    const { maxFreeAccounts } = await loadControls(this.#db)
    return (await countTakenFreePlaces(this.#db)) < maxFreeAccounts
  }

  /**
   * Whether this address may make an account now, taking its free place if so. The check and the
   * take are one step under `lockFreePlaces`, so two sign-ups at the last place get one account,
   * not two; the place is held until the account is written (`holdFreePlace`).
   *
   * An address ADMIN_EMAILS lists always may, and takes no place: it is the deployment's owner,
   * who must be able to get in to raise the cap when sign-up is full, and once confirmed is an
   * admin, whom the cap doesn't count. The list is read from the environment at boot
   * (`config/load.ts`) and nothing else writes it, so nobody can add themselves to it.
   */
  async admits(email: string): Promise<boolean> {
    if (this.#configured.includes(email.toLowerCase()) || !this.#capped) return true
    return this.#db.transaction(async (tx) => {
      await lockFreePlaces(tx)
      const { maxFreeAccounts } = await loadControls(tx)
      if ((await countTakenFreePlaces(tx)) >= maxFreeAccounts) return false
      await holdFreePlace(tx, email)
      return true
    })
  }

  /** An address left to hear when sign-up has room. Kept once; a flood waits a minute. */
  async joinWaitlist(email: string, source: string | null, now = Date.now()): Promise<void> {
    this.#waitlisted = this.#waitlisted.filter((at) => now - at < 60_000)
    if (this.#waitlisted.length >= WAITLIST_PER_MINUTE)
      throw new AppError(
        'rate_limited',
        'A lot of people are joining the list right now. Try again in a minute.',
      )
    this.#waitlisted.push(now)
    await joinWaitlist(this.#db, email, source)
  }

  /**
   * A new account: its standing exists before anything reads it, and the log keeps which Terms
   * the person agreed to when they signed up.
   */
  async opened(userId: string, agreement: SignUpAgreement | null = null): Promise<void> {
    await ensureStanding(this.#db, userId)
    await noteOnce(this.#db, { event: FUNNEL.signedUp, subject: userId, userId })
    if (agreement === null) return
    await this.#db.insert(schema.auditLog).values({
      actor: `user:${userId}`,
      action: 'account.agreed',
      subjectType: 'account',
      subjectId: userId,
      data: { terms: agreement.terms },
    })
  }

  /** A new or newly confirmed account whose email is listed becomes an admin. */
  async configuredAdmin(user: { id: string; email: string; emailVerified: boolean }): Promise<void> {
    if (!user.emailVerified || !this.#configured.includes(user.email.toLowerCase())) return
    await grantAdmin(this.#db, user.id, 'config')
  }

  isAdmin(userId: string): Promise<boolean> {
    return isAdmin(this.#db, userId)
  }

  /** A new password set through a reset link: the account's owner did it, holding the email. */
  async passwordReset(userId: string): Promise<void> {
    await this.#db.insert(schema.auditLog).values({
      actor: `user:${userId}`,
      action: 'account.password_reset',
      subjectType: 'account',
      subjectId: userId,
      data: {},
    })
  }

  /**
   * A suspended account's servers stop, with `policy` as the reason. Ones in the middle of other
   * work are left to the enforcement sweep, which stops them once that work is done; a starting
   * one is refused by its own worker, which re-checks standing before it boots.
   */
  async stopServersOf(
    userId: string,
    reason: 'policy' | 'entitlement' | 'hours' | 'unpaid' = 'policy',
  ): Promise<number> {
    let stopped = 0
    for (const server of await listOwned(this.#db, userId)) {
      if (server.lifecycle.status !== 'running') continue
      await this.#servers.stop(
        reason === 'policy' ? SYSTEM : SYSTEM_ENTITLEMENT,
        server.id,
        `${reason}:${server.id}:${server.version}`,
        reason,
      )
      stopped++
    }
    return stopped
  }

  /**
   * `standing-sweep`: what standing forbids, undone even when it was mid-way through other work
   * when the standing changed. Suspended accounts' servers stop; terminated ones' close.
   */
  async enforce(): Promise<{ stopped: number; closed: number }> {
    let stopped = 0
    let closed = 0
    const inactive = new Set<string>()
    for (const owner of await ownersNotActive(this.#db)) {
      inactive.add(owner.userId)
      if (owner.status === 'suspended') stopped += await this.stopServersOf(owner.userId)
      else closed += await this.closeServersOf(owner.userId, true)
    }
    // A plan that shrank, or limits an admin lowered: what no longer fits stops.
    for (const userId of await ownersRunning(this.#db))
      if (!inactive.has(userId)) {
        await this.warnAboutPlay(userId)
        await warnAboutExtra({ db: this.#db, mailer: this.#mailer, origin: this.#webOrigin }, userId)
        stopped += await this.enforceLimits(userId)
      }
    return { stopped, closed }
  }

  /**
   * What the account's plan allows now, applied to what it runs: everything stops while it owes
   * money (`unpaid`) or once its play is used up (`hours`); otherwise servers
   * the plan doesn't run (a size it never sold, or mods it doesn't include) stop, then the most
   * recently started beyond the plan's running limit, all with reason `entitlement`. Nothing is
   * deleted or changed.
   */
  async enforceLimits(userId: string): Promise<number> {
    const standing = await loadStanding(this.#db, userId)
    const allowed = entitlementsFor(standing.plan, standing.limitOverrides)
    // Money owed from a payment that didn't go through stops everything until it is paid.
    const { decision, owedCents } = await extraPlayNow(this.#db, standing)
    if (owedCents > 0) return await this.stopServersOf(userId, 'unpaid')
    // Play that has run out stops everything, not just the next start: a run already going is
    // what spends the money. Nobody is ever charged past what they allowed (§15.5), and extra
    // play that stopped being allowed (a cancel, a failed payment) stops at the included block.
    const spent = await this.#spentItsPlay(userId, allowed, extraUnits(decision))
    if (spent) return await this.stopServersOf(userId, 'hours')
    const started = new Map<string, number>()
    const running = (await listOwned(this.#db, userId)).filter((s) => RUNNING.has(s.lifecycle.status))
    for (const server of running)
      started.set(server.id, (await openIntervalStart(this.#db, server.id))?.getTime() ?? Date.now())
    // The longest running keep going; the ones started last are the ones stopped.
    running.sort((a, b) => (started.get(a.id) ?? 0) - (started.get(b.id) ?? 0))
    // A size the plan once sold keeps running (a plan-table change breaks nothing); one it never
    // sold, after a downgrade, does not, and nor does a server playing what the plan doesn't run,
    // such as a modpack after Plus ends. Stopped, never changed: it starts again with the plan.
    const runnable = new Map<string, boolean>()
    for (const server of running) {
      const revision = await loadRevision(this.#db, server.desiredRevisionId)
      runnable.set(server.id, planGap(allowed, runsOf(server.memoryTier, revision), 'startable') === null)
    }
    const unrunnable = running.filter((s) => !runnable.get(s.id))
    const fitting = running.filter((s) => runnable.get(s.id))
    const extra = fitting.slice(allowed.maxRunning)
    // A server still starting counts, but only a running one can be stopped: the next sweep
    // stops a starting one once it is up.
    const due = [...unrunnable, ...extra].filter((s) => s.lifecycle.status === 'running')
    for (const server of due)
      await this.#servers.stop(
        SYSTEM_ENTITLEMENT,
        server.id,
        `limits:${server.id}:${server.version}`,
        'entitlement',
      )
    return due.length
  }

  /**
   * Nobody should meet their play running out for the first time when their servers stop. This
   * says it at half, at four fifths and when it happens, once each a month, by email and in the
   * same words the account page uses. The record of what was said lives on the standing, so a
   * restarted control plane never repeats one and a new month starts quiet.
   */
  async warnAboutPlay(userId: string, now = new Date()): Promise<number | null> {
    const standing = await loadStanding(this.#db, userId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    if (plan.includedUnits === null || plan.includedUnits === 0) return null
    const { decision } = await extraPlayNow(this.#db, standing)
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const units = await runUnitsSince(this.#db, userId, monthStart, now)
    const share = (units / plan.includedUnits) * 100
    const reached = [...WARN_AT].reverse().find((mark) => share >= mark)
    if (reached === undefined) return null

    const month = monthStart.toISOString().slice(0, 7)
    const [saidMonth, saidMark] = (standing.playWarned ?? '').split(':')
    if (saidMonth === month && Number(saidMark) >= reached) return null

    const to = await emailOf(this.#db, userId)
    if (to !== null)
      await this.#mailer.send({
        to,
        ...playWarning({
          mark: reached,
          included: plan.includedUnits,
          used: Math.round(units * 10) / 10,
          extraAllowed: extraUnits(decision),
          mayBuyMore: decision.may,
          origin: this.#webOrigin,
        }),
      })
    await this.#db.transaction(async (tx) => {
      const locked = await lockStanding(tx, userId)
      if (locked !== null) await saveStanding(tx, userId, { playWarned: `${month}:${reached}` })
    })
    return reached
  }

  /** Whether this month's play is used up, counting what is running now up to this moment. */
  async #spentItsPlay(userId: string, allowed: Entitlements, extra: number): Promise<boolean> {
    if (allowed.includedUnits === null) return false
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const units = await runUnitsSince(this.#db, userId, monthStart, now)
    return units >= allowed.includedUnits + extra
  }

  /** A terminated account's servers are deleted and purged, the ones in its trash too. */
  async closeServersOf(userId: string, onlyOpen = false): Promise<number> {
    let closed = 0
    for (const server of await listUnpurged(this.#db, userId)) {
      // The sweep leaves servers already on their way to purge alone.
      if (onlyOpen && server.purgeAfter !== null && server.purgeAfter <= new Date()) continue
      await this.#servers.terminate(SYSTEM, server.id)
      closed++
    }
    return closed
  }

  async #change(
    actor: Actor,
    userId: string,
    action: string,
    data: Record<string, unknown>,
    apply: (tx: Tx, standing: NonNullable<Awaited<ReturnType<typeof lockStanding>>>) => Promise<void>,
  ): Promise<void> {
    if (actor.kind !== 'admin') throw new NotFound('Account')
    await this.#db.transaction(async (tx) => {
      const standing = await lockStanding(tx, userId)
      if (standing === null) throw new NotFound('Account')
      await apply(tx, standing)
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action,
        subjectType: 'account',
        subjectId: userId,
        data,
      })
      // Standing, restrictions and plans are eligibility inputs (§15.3).
      await this.#jobs.enqueueEligibility(await listingsOfOwner(tx, userId), tx)
    })
  }
}

/** Standing is enforced by the platform itself, not by the admin who changed it. */
const SYSTEM: Actor = { kind: 'system', reason: 'policy' }
const SYSTEM_ENTITLEMENT: Actor = { kind: 'system', reason: 'entitlement' }

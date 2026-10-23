// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gifts: time on a paid plan that one account buys and another redeems with a code. The provider
 * sells each gift as a one-time product (`giftProducts`); its paid order makes the gift here and
 * emails its buyer the code, of which only a hash is kept. A gift made before its checkout, as one
 * a guest buys (GIFTS_BY_EMAIL), is named in its order (`giftId`) and found by that. Redeeming
 * gives the account the plan for the gift's months, from then or from when the time it already has
 * ends (a year paid at once included), and `billedPlan` reads it from there. A refund voids a code nobody has used, and ends
 * the time of one somebody has. A gift redeemed to start when a subscription set to end runs out
 * moves on if the subscription is kept and renews, so it never runs under paid days. Buying is
 * capped per buyer per day, and wrong codes per account per hour.
 *
 * Not here: the plan's own checkout and subscriptions (`service.ts`).
 */
import type { GiftOptionView, GiftView, RedeemedGiftView } from '@blockly/contracts'
import { DAY_MS, HOUR_MS } from '@blockly/contracts/durations'
import { type Db, type Queryable, schema, type Tx } from '@blockly/db'
import { and, asc, count, desc, eq, gt, isNotNull, isNull, lte, max, ne, sql } from 'drizzle-orm'
import { emailOf, isTestAccount, loadStanding, lockStanding } from '../accounts/persistence.ts'
import type { AccountService } from '../accounts/service.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { giftCode } from '../emails/gifts.ts'
import { AppError, NotFound } from '../errors.ts'
import { listingsOfOwner } from '../listings/persistence.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { JobQueue } from '../ports/jobs.ts'
import { type BillingOrder, BillingUnavailable, type GiftProduct } from '../ports/optional.ts'
import type { Mailer } from '../ports/platform.ts'
import { tuning } from '../tuning.ts'
import { type AuditEntry, planChange, writeEntries } from './audit.ts'
import { codeHash, codeHint, newCode, readCode } from './gift-codes.ts'
import { latestSubscription, PAID_ORDER, PAYING } from './persistence.ts'
import { addMonths, lastYearEnd } from './years.ts'

const gifts = schema.planGifts

const REFUSED = 'That code doesn’t work. Check it against the email it came in.'

/**
 * What an order paid for: a gift made before its checkout, which the order names (`giftId`), with
 * the email it was paid with; or a gift its paid order makes, for the account that paid.
 */
type Paid = { giftId: string; payerEmail: string | null } | { buyerId: string; gift: GiftProduct }

export class Gifts {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #accounts: AccountService
  readonly #jobs: JobQueue
  readonly #mailer: Mailer
  readonly #webOrigin: string

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    capabilities: DeploymentCapabilities
    accounts: AccountService
    jobs: JobQueue
    mailer: Mailer
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#accounts = deps.accounts
    this.#jobs = deps.jobs
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
  }

  /** The gifts on sale, for anyone; none where the deployment takes no payments. */
  async options(): Promise<GiftOptionView[]> {
    if (this.#caps.billing === null) return []
    const billing = this.#caps.billing
    return reach(() => billing.giftProducts())
  }

  /**
   * A checkout for one gift. The buyer has agreed to the Terms, which say how a gift is
   * refunded; with `AbuseLimits.giftsPerDay` paid in the last day, they wait. The provider offers a checkout
   * still open for the same gift again, so no more than one is open per gift at a time.
   */
  async buy(actor: Actor, optionId: string, consent: { terms: string }): Promise<{ url: string }> {
    const user = await this.#person(actor)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    const [today] = await this.#db
      .select({ n: count() })
      .from(gifts)
      .where(and(eq(gifts.buyerId, user.id), gt(gifts.createdAt, new Date(Date.now() - DAY_MS))))
    const most = tuning().abuse.giftsPerDay
    if ((today?.n ?? 0) >= most)
      throw new AppError(
        'rate_limited',
        `You’ve bought ${most} gifts today, the most for one day. You can buy more tomorrow.`,
      )
    const billing = requireCapability(this.#caps, 'billing')
    const gift = (await reach(() => billing.giftProducts())).find((option) => option.id === optionId)
    if (gift === undefined) throw new AppError('invalid_choice', 'That gift isn’t on sale any more.')
    const returnUrl = new URL('/gift?bought=1', this.#webOrigin).toString()
    const url = await reach(() =>
      billing.giftCheckoutUrl({ userId: user.id, email: user.email, gift, giftId: null, returnUrl }),
    )
    await this.#db.insert(schema.auditLog).values({
      actor: requestedBy(actor),
      action: 'billing.gift_checkout_started',
      subjectType: 'account',
      subjectId: user.id,
      data: { product: gift.id, plan: gift.planKey, months: gift.months, terms: consent.terms },
    })
    return { url }
  }

  /**
   * The provider's word on an order (`BillingService.receiveWebhook`): a gift paid for is made
   * and its code emailed, once; a gift refunded is voided. The refund is the order's as
   * `recordOrder` kept it, which only grows, so a paid delivery that comes after the refund's
   * makes no gift. Anything else is not a gift's. A gift made before its checkout is found by the
   * id its order names, a guest's too, which has no account (`recordOrder`).
   */
  async received(provider: string, order: BillingOrder): Promise<void> {
    const paid: Paid | null = order.giftId
      ? { giftId: order.giftId, payerEmail: order.payerEmail ?? null }
      : order.gift && order.userId !== null
        ? { buyerId: order.userId, gift: order.gift }
        : null
    if (paid === null && order.userId === null) return
    const [kept] = await this.#db
      .select({ refundedCents: schema.billingOrders.refundedCents })
      .from(schema.billingOrders)
      .where(
        and(
          eq(schema.billingOrders.provider, provider),
          eq(schema.billingOrders.externalOrderId, order.externalOrderId),
        ),
      )
    if (order.refundedCents > 0 || (kept?.refundedCents ?? 0) > 0 || order.status === 'refunded') {
      await this.#void(provider, order.externalOrderId, paid)
      return
    }
    if (paid !== null && PAID_ORDER.includes(order.status))
      await this.#issue(provider, order.externalOrderId, paid)
  }

  /**
   * The gift an order paid for, found by the order from here on (`plan_gifts_order`). One made
   * before its checkout is given the order the first time an order names it, paid (`paid`) or
   * refunded, with the email it was paid with where its buyer gave none; a second order naming it
   * finds nothing. Any other is made for the order, once. Answers whether this was that first time.
   */
  async #attach(tx: Tx, provider: string, externalOrderId: string, paid: Paid, state: 'paid' | null) {
    if ('giftId' in paid) {
      const attached = await tx
        .update(gifts)
        .set({
          provider,
          externalOrderId,
          buyerEmail: sql`coalesce(${gifts.buyerEmail}, ${paid.payerEmail})`,
          ...(state === null ? {} : { state }),
        })
        .where(and(eq(gifts.id, paid.giftId), isNull(gifts.externalOrderId)))
        .returning({ id: gifts.id })
      return attached.length > 0
    }
    const made = await tx
      .insert(gifts)
      .values({
        provider,
        externalOrderId,
        buyerId: paid.buyerId,
        planKey: paid.gift.planKey,
        months: paid.gift.months,
      })
      .onConflictDoNothing()
      .returning({ id: gifts.id })
    return made.length > 0
  }

  /**
   * The gift an order paid for, made or found once, and, for one delivered as a code, its code
   * emailed to the buyer. A code is made only as it is emailed: a delivery that failed before the
   * email went makes a new one, which nobody had seen the old one of. One delivered by email waits
   * for its own delivery.
   */
  async #issue(provider: string, externalOrderId: string, paid: Paid) {
    await this.#db.transaction(async (tx) => {
      const first = await this.#attach(tx, provider, externalOrderId, paid, 'paid')
      const [row] = await tx
        .select()
        .from(gifts)
        .where(and(eq(gifts.provider, provider), eq(gifts.externalOrderId, externalOrderId)))
        .for('update')
      if (!row) {
        if ('giftId' in paid)
          console.error(
            `billing: order ${externalOrderId} names gift ${paid.giftId}, which another order paid for`,
          )
        return
      }
      if (row.voidedAt === null) await this.#paidFor(tx, row, first)
    })
  }

  /**
   * A gift paid for, not refunded: one delivered as a code has it emailed to its buyer, unless it
   * was; one delivered by email has its purchase audited the first time (`first`), and waits.
   */
  async #paidFor(tx: Tx, row: typeof gifts.$inferSelect, first: boolean) {
    const bought = [
      { action: 'billing.gift_bought', data: { gift: row.id, plan: row.planKey, months: row.months } },
    ]
    if (row.delivery === 'email') {
      if (first)
        await writeEntries(tx, row.buyerId ?? row.id, 'system:billing', 'webhook', bought, subjectOf(row))
      return
    }
    if (row.emailedAt !== null || row.buyerId === null || !row.planKey || !row.months) return
    await this.#sendCode(tx, row.id, row.buyerId, row.planKey, row.months)
    await writeEntries(tx, row.buyerId, 'system:billing', 'webhook', bought)
  }

  /** A new code for the gift, kept as its hash, and emailed to the buyer in the same breath. */
  async #sendCode(tx: Tx, giftId: string, buyerId: string, planKey: string, months: number) {
    const code = newCode()
    await tx
      .update(gifts)
      .set({ codeHash: codeHash(code), codeHint: codeHint(code), emailedAt: new Date() })
      .where(eq(gifts.id, giftId))
    const to = await emailOf(tx, buyerId)
    if (to !== null)
      await this.#mailer.send({ to, ...giftCode({ code, planKey, months, origin: this.#webOrigin }) })
  }

  /**
   * A refund: the code stops working, and time already redeemed with it ends now. The account that
   * had it moves to the plan it has without it, and what that plan doesn't allow stops. A gift
   * order refunded before its paid delivery is handled (`paid`) is kept as a gift refunded, with no
   * code, so its paid delivery coming after never makes one; a gift made before its checkout is
   * found by its id for that. Who it was for is kept no longer.
   */
  async #void(provider: string, externalOrderId: string, paid: Paid | null): Promise<void> {
    const redeemedBy = await this.#db.transaction(async (tx) => {
      if (paid !== null) await this.#attach(tx, provider, externalOrderId, paid, null)
      const [row] = await tx
        .select()
        .from(gifts)
        .where(and(eq(gifts.provider, provider), eq(gifts.externalOrderId, externalOrderId)))
        .for('update')
      if (!row || row.voidedAt !== null) return null
      if (row.redeemedBy !== null) await lockStanding(tx, row.redeemedBy)
      const now = new Date()
      const before = row.redeemedBy === null ? null : (await loadStanding(tx, row.redeemedBy, now)).plan
      await tx
        .update(gifts)
        .set({ voidedAt: now, state: 'refunded', recipientEmail: null })
        .where(eq(gifts.id, row.id))
      await writeEntries(
        tx,
        row.buyerId ?? row.id,
        'system:billing',
        'webhook',
        [{ action: 'billing.gift_refunded', data: { gift: row.id, redeemed: row.redeemedBy !== null } }],
        subjectOf(row),
      )
      if (row.redeemedBy !== null && before !== null)
        await writeEntries(
          tx,
          row.redeemedBy,
          'system:billing',
          'webhook',
          planChange(before, (await loadStanding(tx, row.redeemedBy, now)).plan, { gift: row.id }),
        )
      return row.redeemedBy
    })
    if (redeemedBy !== null) await this.#accounts.enforceLimits(redeemedBy)
  }

  /**
   * Redeems a code for the account: its months of the plan, from now, or from when the time it has
   * ends (gifts redeemed before, or a subscription set to end). An account whose subscription
   * renews is told to set it to end first, so nobody pays and redeems for the same month.
   */
  async redeem(actor: Actor, typed: string): Promise<RedeemedGiftView> {
    const user = await this.#person(actor)
    await this.#db.transaction((tx) => this.#policy.require(tx, user.id, { kind: 'billing' }))
    await this.#holdGuessing(user.id)
    const code = readCode(typed)
    const [found] =
      code === null
        ? []
        : await this.#db
            .select()
            .from(gifts)
            .where(eq(gifts.codeHash, codeHash(code)))
            .limit(1)
    if (found === undefined || found.voidedAt !== null || found.planKey === null || found.months === null)
      return this.#refuse(actor, user.id, REFUSED)
    if (found.redeemedBy !== null)
      return this.#refuse(
        actor,
        user.id,
        found.redeemedBy === user.id ? 'You’ve redeemed this code already.' : 'That code has been used.',
      )
    const latest = await latestSubscription(this.#db, user.id)
    if (
      latest !== null &&
      (latest.status === 'past_due' || (PAYING.includes(latest.status) && !latest.cancelAtPeriodEnd))
    )
      throw new AppError(
        'invalid_choice',
        'Your plan renews on your card. Set it to end in Manage billing, then redeem the code: it starts when your paid time ends.',
      )
    const redeemed = await this.#db.transaction(async (tx) => {
      const held = await lockStanding(tx, user.id)
      // A plan an admin gave the account is set on it, and no gift is needed on top.
      if (held !== null && held.plan !== 'free')
        throw new AppError(
          'invalid_choice',
          'This account has its plan from Cubepals already, so it can’t take a gift.',
        )
      const [row] = await tx.select().from(gifts).where(eq(gifts.id, found.id)).for('update')
      if (!row || row.redeemedBy !== null || row.voidedAt !== null || !row.planKey || !row.months)
        throw new AppError('changed_meanwhile', 'That code was used a moment ago.')
      const now = new Date()
      const startsAt = await this.#nextStart(tx, user.id, now, latest)
      const endsAt = addMonths(startsAt, row.months)
      const before = (await loadStanding(tx, user.id, now)).plan
      await tx
        .update(gifts)
        .set({
          redeemedBy: user.id,
          redeemedAt: now,
          startsAt,
          endsAt,
          state: 'claimed',
          recipientEmail: null,
        })
        .where(eq(gifts.id, row.id))
      await writeEntries(tx, user.id, requestedBy(actor), 'user', [
        {
          action: 'billing.gift_redeemed',
          data: {
            gift: row.id,
            plan: row.planKey,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
          },
        },
        ...planChange(before, (await loadStanding(tx, user.id, now)).plan, { gift: row.id }),
      ])
      // Whether a plan lists publicly is an eligibility input (§15.3).
      await this.#jobs.enqueueEligibility(await listingsOfOwner(tx, user.id), tx)
      return { planKey: row.planKey, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }
    })
    await this.#accounts.enforceLimits(user.id)
    return redeemed
  }

  /**
   * When a new gift's time starts: now, or when the account's gifts, its years or a
   * subscription set to end run out.
   */
  async #nextStart(
    tx: Tx,
    userId: string,
    now: Date,
    latest: Awaited<ReturnType<typeof latestSubscription>>,
  ): Promise<Date> {
    const [last] = await tx
      .select({ endsAt: max(gifts.endsAt) })
      .from(gifts)
      .where(and(eq(gifts.redeemedBy, userId), isNull(gifts.voidedAt)))
    const ends = [now.getTime()]
    if (last?.endsAt) ends.push(new Date(last.endsAt).getTime())
    // A year paid at once (`years.ts`) runs first, and the gift after it.
    const year = await lastYearEnd(tx, userId)
    if (year !== null) ends.push(year.getTime())
    if (latest !== null && PAYING.includes(latest.status) && latest.currentPeriodEnd !== null)
      ends.push(latest.currentPeriodEnd.getTime())
    return new Date(Math.max(...ends))
  }

  /** A wrong code, counted against the hour's, and refused. */
  async #refuse(actor: Actor, userId: string, message: string): Promise<never> {
    await this.#db.insert(schema.auditLog).values({
      actor: requestedBy(actor),
      action: 'billing.gift_code_refused',
      subjectType: 'account',
      subjectId: userId,
      data: {},
    })
    throw new AppError('invalid_choice', message)
  }

  /** Past `AbuseLimits.wrongCodesPerHour` wrong codes in an hour, the account waits. */
  async #holdGuessing(userId: string): Promise<void> {
    const [wrong] = await this.#db
      .select({ n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.subjectType, 'account'),
          eq(schema.auditLog.subjectId, userId),
          eq(schema.auditLog.action, 'billing.gift_code_refused'),
          gt(schema.auditLog.at, new Date(Date.now() - HOUR_MS)),
        ),
      )
    if ((wrong?.n ?? 0) >= tuning().abuse.wrongCodesPerHour)
      throw new AppError('rate_limited', 'That’s a lot of codes that didn’t work. Try again in an hour.')
  }

  /** The gifts the account bought, newest first; not one whose checkout was never paid. */
  async mine(actor: Actor): Promise<GiftView[]> {
    const user = await this.#person(actor)
    const rows = await this.#db
      .select()
      .from(gifts)
      .where(and(eq(gifts.buyerId, user.id), ne(gifts.state, 'checkout')))
      .orderBy(desc(gifts.createdAt))
    return rows.map((row) => ({
      id: row.id,
      planKey: row.planKey,
      months: row.months,
      codeHint: row.codeHint,
      state: row.voidedAt !== null ? 'refunded' : row.redeemedBy !== null ? 'redeemed' : 'waiting',
      boughtAt: row.createdAt.toISOString(),
      redeemedAt: row.redeemedAt?.toISOString() ?? null,
    }))
  }

  /**
   * A new code for a gift nobody has redeemed, emailed to its buyer, for one whose email went
   * missing: only the hash of the old one was kept, and it stops working.
   */
  async resend(actor: Actor, giftId: string): Promise<void> {
    const user = await this.#person(actor)
    await this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(gifts)
        .where(and(eq(gifts.id, giftId), eq(gifts.buyerId, user.id)))
        .for('update')
      // One not paid for yet is not the buyer's to see, and one delivered by email has no code.
      if (!row || row.state === 'checkout') throw new NotFound('Gift')
      if (
        row.delivery !== 'code' ||
        row.redeemedBy !== null ||
        row.voidedAt !== null ||
        !row.planKey ||
        !row.months
      )
        throw new AppError(
          'invalid_choice',
          'That gift has been redeemed or refunded, so it has no code to send.',
        )
      await this.#sendCode(tx, row.id, user.id, row.planKey, row.months)
      await writeEntries(tx, user.id, requestedBy(actor), 'user', [
        { action: 'billing.gift_code_sent_again', data: { gift: row.id } },
      ])
    })
  }

  /**
   * `standing-sweep`: redeemed time that ran out, each recorded once with the plan change it made,
   * and what the plan after it doesn't allow stopped. Answers how many ended.
   */
  async recordEnds(now = new Date()): Promise<number> {
    const ended = await this.#db
      .select({ id: gifts.id, userId: gifts.redeemedBy, endsAt: gifts.endsAt })
      .from(gifts)
      .where(
        and(
          isNotNull(gifts.redeemedBy),
          isNull(gifts.voidedAt),
          isNull(gifts.endRecordedAt),
          lte(gifts.endsAt, now),
        ),
      )
    for (const gift of ended) {
      if (gift.userId === null || gift.endsAt === null) continue
      const userId = gift.userId
      const endsAt = gift.endsAt
      await this.#db.transaction(async (tx) => {
        await lockStanding(tx, userId)
        const before = (await loadStanding(tx, userId, new Date(endsAt.getTime() - 1))).plan
        const after = (await loadStanding(tx, userId, now)).plan
        await tx.update(gifts).set({ endRecordedAt: now }).where(eq(gifts.id, gift.id))
        await writeEntries(tx, userId, 'system:billing', 'scheduled', [
          { action: 'billing.gift_ended', data: { gift: gift.id, endedAt: endsAt.toISOString() } },
          ...planChange(before, after, { gift: gift.id }),
        ])
      })
      await this.#accounts.enforceLimits(userId)
    }
    return ended.length
  }

  async #person(actor: Actor): Promise<{ id: string; email: string }> {
    if (actor.kind === 'system' || actor.kind === 'operator') throw new NotFound('Account')
    const [user] = await this.#db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId))
    if (!user) throw new NotFound('Account')
    // A test account's plan is an admin's to set, never bought or given.
    if (await isTestAccount(this.#db, user.id))
      throw new AppError('invalid_choice', 'This is a test account: its plan is set by an admin.')
    return user
  }
}

/**
 * Redeemed gifts under a subscription that renews (`BillingService.syncSubscription`), as when its
 * owner set it to end, redeemed a gift to start then, and kept it after all: each gift that would
 * start before the paid time ends (`paidUntil`), or is running, moves to start then, and the gifts
 * after it run on from it, so a gift never runs under days that are paid for. One that hasn't
 * started keeps its months; one running keeps the time it had left. Run under the account's
 * standing lock. Answers the moves, for the audit log.
 */
export async function giftsAfterPaidTime(
  tx: Tx,
  userId: string,
  paidUntil: Date,
  now: Date,
): Promise<AuditEntry[]> {
  const held = await tx
    .select()
    .from(gifts)
    .where(and(eq(gifts.redeemedBy, userId), isNull(gifts.voidedAt), gt(gifts.endsAt, now)))
    .orderBy(asc(gifts.startsAt))
  const moves: AuditEntry[] = []
  let from = paidUntil
  for (const gift of held) {
    if (gift.startsAt === null || gift.endsAt === null || gift.months === null) continue
    if (gift.startsAt >= from) {
      if (gift.endsAt > from) from = gift.endsAt
      continue
    }
    const startsAt = from
    const endsAt =
      gift.startsAt > now
        ? addMonths(startsAt, gift.months)
        : new Date(startsAt.getTime() + gift.endsAt.getTime() - now.getTime())
    await tx.update(gifts).set({ startsAt, endsAt }).where(eq(gifts.id, gift.id))
    moves.push({
      action: 'billing.gift_moved',
      data: {
        gift: gift.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        was: gift.startsAt.toISOString(),
      },
    })
    from = endsAt
  }
  return moves
}

/**
 * For the account page: the first redeemed gift still to start, its plan, its months, when it
 * starts and ends, and whether it ran already before paid time moved it (`continues`: what is left
 * of it runs then, not its months whole); null with none waiting.
 */
export async function giftNext(
  q: Queryable,
  userId: string,
  now: Date,
): Promise<{ planKey: string; months: number; startsAt: Date; endsAt: Date; continues: boolean } | null> {
  const [row] = await q
    .select({ planKey: gifts.planKey, months: gifts.months, startsAt: gifts.startsAt, endsAt: gifts.endsAt })
    .from(gifts)
    .where(and(eq(gifts.redeemedBy, userId), isNull(gifts.voidedAt), gt(gifts.startsAt, now)))
    .orderBy(asc(gifts.startsAt))
    .limit(1)
  if (!row?.planKey || !row.months || !row.startsAt || !row.endsAt) return null
  const continues = row.endsAt < addMonths(row.startsAt, row.months)
  return { planKey: row.planKey, months: row.months, startsAt: row.startsAt, endsAt: row.endsAt, continues }
}

/** What a gift's audit entries are about: its buyer's account, or the gift itself for a guest's. */
const subjectOf = (row: { buyerId: string | null }) => (row.buyerId === null ? 'gift' : 'account')

/** The provider being down is a refusal people can read, not an internal error. */
async function reach<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof BillingUnavailable)
      throw new AppError(
        'billing_unavailable',
        'Payments are not answering right now. Try again in a minute.',
      )
    throw error
  }
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Friends chipping in to a server: a one-time payment through
 * the billing provider's chip-in product, from the server's page or an invitation, that becomes
 * hours of play on that server, at the price of extra play. Its order's word keeps it
 * (`chip_ins`); each minute, before extra play is counted, the play it covered is drawn and kept
 * (`chip_in_draws`), so covered play is never counted against the owner nor billed. The owner sees
 * who chipped in and can turn it off. Hours are kept in hours and cents, never as credit, so they
 * can become credit as they are.
 *
 * It is not where covered play is read (`chip-in-meter.ts`) or where a server may run on it (the
 * policy and `AccountService.enforceLimits`).
 */
import { CHIP_IN_CENTS, type ChipInsView } from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'
import { type Db, type Queryable, schema, type Tx } from '@blockly/db'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { heldMilli, milliFor } from '../../domain/account/chip-in.ts'
import { entitlementsOf } from '../../domain/account/entitlements.ts'
import { shownName } from '../../domain/listing/author.ts'
import { dollars } from '../../domain/policy/spend.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { emailVerified, isTestAccount, loadStanding, lockAccountActions } from '../accounts/persistence.ts'
import { type Actor, requestedBy, type UserActor } from '../actor.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import { type BillingOrder, BillingUnavailable } from '../ports/optional.ts'
import { findServer } from '../servers/persistence.ts'
import { tuning } from '../tuning.ts'
import { pendingDraws } from './chip-in-meter.ts'
import { PAID_ORDER } from './persistence.ts'

const chipIns = schema.chipIns
const log = schema.auditLog

/** Whether a server's page offers chipping in: its owner lets it, and its plan has monthly hours. */
export async function offersChipIn(
  q: Queryable,
  server: MinecraftServer,
  billing: boolean,
): Promise<boolean> {
  if (!billing || server.deletedAt !== null) return false
  const standing = await loadStanding(q, server.ownerId)
  if (standing.status !== 'active') return false
  if (entitlementsOf(standing).includedUnits === null) return false
  const [closed] = await q
    .select({ id: schema.chipInClosed.serverId })
    .from(schema.chipInClosed)
    .where(eq(schema.chipInClosed.serverId, server.id))
  return closed === undefined
}

/** What the chip-ins started that match `where` came to, in cents. */
async function started(q: Queryable, where: ReturnType<typeof and>): Promise<number> {
  const [row] = await q
    .select({ cents: sql<string>`coalesce(sum((${log.data}->>'cents')::int), 0)` })
    .from(log)
    .where(and(eq(log.action, 'billing.chip_in_started'), where))
  return Number(row?.cents ?? 0)
}

export class ChipIns {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #webOrigin: string

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    capabilities: DeploymentCapabilities
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#webOrigin = deps.webOrigin
  }

  /**
   * A checkout for `cents` of hours on `server`, reached from `page` (its public page or an
   * invitation, where the payer comes back to). Refused past the caps (`AbuseLimits.chipIn`), counted
   * from the checkouts started in the last day, so a stolen card can't do much. The start is kept
   * before its checkout is made, and dropped again if the provider makes none.
   */
  async start(
    actor: Actor,
    server: MinecraftServer | null,
    cents: number,
    page: string,
  ): Promise<{ url: string }> {
    if (actor.kind !== 'user') throw new NotFound('Account')
    if (server === null) throw new NotFound('Server')
    if (!Number.isInteger(cents) || cents < CHIP_IN_CENTS.min || cents > CHIP_IN_CENTS.max)
      throw new AppError(
        'invalid_choice',
        `A chip-in is ${dollars(CHIP_IN_CENTS.min)} to ${dollars(CHIP_IN_CENTS.max)}.`,
      )
    const billing = requireCapability(this.#caps, 'billing')
    if (server.ownerId === actor.userId)
      throw new AppError('invalid_choice', 'This is your own server. Extra hours for it are on your account.')
    if (!(await offersChipIn(this.#db, server, true)))
      throw new AppError('invalid_choice', 'This server doesn’t take chip-ins right now.')
    const [payer] = await this.#db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId))
    if (payer === undefined) throw new NotFound('Account')
    if (await isTestAccount(this.#db, actor.userId))
      throw new AppError('invalid_choice', 'This is a test account: it never pays.')
    if (!(await emailVerified(this.#db, actor.userId)))
      throw new AppError('email_unverified', 'Confirm your email address first — we sent you a link.')
    await this.#db.transaction((tx) => this.#policy.require(tx, actor.userId, { kind: 'billing' }))
    const counted = await this.#db.transaction((tx) => this.#within(tx, actor, server, cents))
    const returnUrl = new URL(page, this.#webOrigin)
    returnUrl.searchParams.set('chipped', '1')
    const url = await billing
      .chipInUrl({
        userId: actor.userId,
        email: payer.email,
        serverId: server.id,
        cents,
        returnUrl: returnUrl.toString(),
      })
      .catch(async (error: unknown) => {
        // Payments not answering (an outage, a timeout) may still have made the checkout, so its
        // start stays counted. Any other failure is a refusal that made none, so the start is taken
        // back; if that fails too, it stays counted for the day and the payer still hears why.
        if (error instanceof BillingUnavailable)
          throw new AppError(
            'billing_unavailable',
            'Payments are not answering right now. Try again in a minute.',
          )
        await this.#db
          .delete(log)
          .where(eq(log.id, counted))
          .catch(() => undefined)
        throw error
      })
    return { url }
  }

  /**
   * The chip-in counted against the day's caps (`AbuseLimits.chipIn`) and kept as started, under
   * the payer's and the server's locks, so each start counts every one before it; answers the
   * entry that counts it. Refused past either cap.
   */
  async #within(tx: Tx, actor: UserActor, server: MinecraftServer, cents: number): Promise<string> {
    // Always the payer first, then the server, so two starts never wait on each other's.
    await lockAccountActions(tx, actor.userId)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`chip-in-started:${server.id}`}))`)
    const since = new Date(Date.now() - DAY_MS)
    const caps = tuning().abuse.chipIn
    const byPayer = await started(tx, and(eq(log.subjectId, actor.userId), gte(log.at, since)))
    if (byPayer + cents > caps.payerDayCents)
      throw new AppError(
        'limit_reached',
        `You can chip in up to ${dollars(caps.payerDayCents)} a day. Try again tomorrow.`,
      )
    const toServer = await started(tx, and(sql`${log.data}->>'server' = ${server.id}`, gte(log.at, since)))
    if (toServer + cents > caps.serverDayCents)
      throw new AppError(
        'limit_reached',
        `${server.name} has had all the chip-ins it can take today. Try again tomorrow.`,
      )
    const [entry] = await tx
      .insert(log)
      .values({
        actor: requestedBy(actor),
        action: 'billing.chip_in_started',
        subjectType: 'account',
        subjectId: actor.userId,
        data: { server: server.id, cents },
      })
      .returning({ id: log.id })
    if (entry === undefined) throw new Error('the chip-in was not kept as started')
    return entry.id
  }

  /**
   * An order's word about a chip-in: paid, it is kept, and refunded later, it holds that much less.
   * Its hours are what its price before any discount bought (`milliFor`); tax is included in it. One
   * for a server this deployment doesn't have, or from someone it doesn't know, is not kept.
   */
  async record(provider: string, order: BillingOrder): Promise<void> {
    if (order.chipIn === null || order.userId === null || !PAID_ORDER.includes(order.status)) return
    const server = await findServer(this.#db, order.chipIn)
    if (server === null) return
    const cents = order.subtotalCents - order.discountCents
    const kept = await this.#db
      .insert(chipIns)
      .values({
        provider,
        externalOrderId: order.externalOrderId,
        serverId: server.id,
        payerId: order.userId,
        cents,
        netCents: order.netCents,
        refundedCents: order.refundedCents,
        milli: milliFor(cents),
      })
      .onConflictDoUpdate({
        target: [chipIns.provider, chipIns.externalOrderId],
        set: {
          refundedCents: sql`greatest(${chipIns.refundedCents}, ${order.refundedCents})`,
          updatedAt: new Date(),
        },
      })
      .returning({ new: sql<boolean>`xmax = 0` })
    if (!kept[0]?.new) return
    await this.#db.insert(log).values({
      actor: 'system:billing',
      action: 'billing.chip_in_paid',
      subjectType: 'server',
      subjectId: server.id,
      data: { order: order.externalOrderId, payer: order.userId, cents, milli: milliFor(cents) },
    })
  }

  /**
   * `extra-play-report`, before extra play is counted: the play hours chipped in covered since each
   * owner's mark, kept, and the mark moved up to now. Only owners with hours left, or chipped in
   * since their mark, have anything to draw.
   */
  async draw(now = new Date()): Promise<number> {
    const owners = await this.#db
      .selectDistinct({ ownerId: schema.minecraftServers.ownerId })
      .from(chipIns)
      .innerJoin(schema.minecraftServers, eq(schema.minecraftServers.id, chipIns.serverId))
    let drawn = 0
    for (const { ownerId } of owners)
      drawn += await this.#db.transaction(async (tx) => {
        // One draw per owner at a time: two would cover the same play twice.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`chip-in:${ownerId}`}))`)
        const pending = await pendingDraws(tx, ownerId, now)
        if (pending === null || pending.mark >= now) return 0
        if (pending.covered.length > 0)
          await tx.insert(schema.chipInDraws).values(
            pending.covered.map((span) => ({
              serverId: span.serverId,
              ownerId,
              startedAt: new Date(span.start),
              endedAt: new Date(span.end),
              rate: span.rate,
            })),
          )
        await tx
          .insert(schema.chipInMarks)
          .values({ userId: ownerId, drawnThrough: now })
          .onConflictDoUpdate({ target: schema.chipInMarks.userId, set: { drawnThrough: now } })
        return pending.covered.length
      })
    return drawn
  }

  /**
   * What the owner sees of a server's chip-ins. Each friend is named as a guestbook names them,
   * "Davi H.", since the owner of a public server may be a stranger to them; "A friend" where the
   * account has no name to show.
   */
  async view(actor: Actor, serverId: string): Promise<ChipInsView> {
    const server = await this.#owned(actor, serverId)
    const rows = await this.#db
      .select({
        name: schema.users.name,
        milli: chipIns.milli,
        netCents: chipIns.netCents,
        refundedCents: chipIns.refundedCents,
        at: chipIns.receivedAt,
      })
      .from(chipIns)
      .innerJoin(schema.users, eq(schema.users.id, chipIns.payerId))
      .where(eq(chipIns.serverId, server.id))
      .orderBy(desc(chipIns.receivedAt))
    const pending = await pendingDraws(this.#db, server.ownerId, new Date())
    const [closed] = await this.#db
      .select({ id: schema.chipInClosed.serverId })
      .from(schema.chipInClosed)
      .where(eq(schema.chipInClosed.serverId, server.id))
    return {
      open: closed === undefined,
      offered: await offersChipIn(this.#db, server, this.#caps.billing !== null),
      hoursLeft: Math.floor((pending?.left.get(server.id) ?? 0) * 10) / 10,
      people: rows
        .map((row) => ({
          name: shownName(row.name) ?? 'A friend',
          hours: heldMilli(row) / 1000,
          at: row.at.toISOString(),
        }))
        .filter((row) => row.hours > 0),
    }
  }

  /** The owner lets friends chip in, or doesn't. Hours already chipped in stay the server's. */
  async setOpen(actor: Actor, serverId: string, open: boolean): Promise<ChipInsView> {
    const server = await this.#owned(actor, serverId)
    const changed = open
      ? await this.#db
          .delete(schema.chipInClosed)
          .where(eq(schema.chipInClosed.serverId, server.id))
          .returning()
      : await this.#db
          .insert(schema.chipInClosed)
          .values({ serverId: server.id })
          .onConflictDoNothing()
          .returning()
    if (changed.length > 0)
      await this.#db.insert(log).values({
        actor: requestedBy(actor),
        action: open ? 'server.chip_in_opened' : 'server.chip_in_closed',
        subjectType: 'server',
        subjectId: server.id,
        data: {},
      })
    return this.view(actor, serverId)
  }

  async #owned(actor: Actor, serverId: string): Promise<MinecraftServer> {
    const server = await findServer(this.#db, serverId)
    if (server === null || actor.kind !== 'user' || server.ownerId !== actor.userId)
      throw new NotFound('Server')
    return server
  }
}

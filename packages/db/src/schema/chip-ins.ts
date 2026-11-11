// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Friends chipping in to a server they play on: what each paid, as the billing provider reported
 * it, and the play those hours covered. Hours chipped in are the server's, kept until played, and
 * cover its play once its owner's included hours for the month are used, before any extra play the
 * owner would pay for (`apps/control/src/app/billing/chip-ins.ts`).
 */
import { doublePrecision, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth.ts'
import { createdAt, ts, updatedAt } from './columns.ts'
import { minecraftServers } from './servers.ts'

/**
 * One chip-in, one row per paid order of the provider's chip-in product. `cents` is the price the
 * payer chose, tax included, which bought `milli` thousandths of an hour at the price of extra
 * play then; what was refunded of it (`refundedCents`, of `netCents`, before tax, as the provider
 * counts a refund) takes the same share of its hours back. `receivedAt` is when Blockly heard it
 * was paid: its hours cover play from then on, never before.
 */
export const chipIns = pgTable(
  'chip_ins',
  {
    provider: text('provider').notNull(),
    externalOrderId: text('external_order_id').notNull(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    payerId: text('payer_id')
      .notNull()
      .references(() => users.id),
    cents: integer('cents').notNull(),
    netCents: integer('net_cents').notNull(),
    refundedCents: integer('refunded_cents').notNull().default(0),
    milli: integer('milli').notNull(),
    /**
     * The hours of it not yet played when its payer cancelled it within its 14 days, in
     * thousandths: from then they can't be played, whatever the refund that follows.
     */
    withdrawnMilli: integer('withdrawn_milli').notNull().default(0),
    receivedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.externalOrderId] }),
    index('chip_ins_server').on(t.serverId),
    index('chip_ins_payer').on(t.payerId, t.receivedAt),
  ],
)

/**
 * Play that hours chipped in covered: a span of one server's run, at the units an hour its size
 * counts. Covered play never counts against its owner's hours, nor is it billed as extra.
 */
export const chipInDraws = pgTable(
  'chip_in_draws',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at').notNull(),
    rate: doublePrecision('rate').notNull(),
  },
  (t) => [
    index('chip_in_draws_owner').on(t.ownerId, t.endedAt),
    index('chip_in_draws_server').on(t.serverId),
  ],
)

/** How far an owner's play has been drawn from what was chipped in: every draw ends by here. */
export const chipInMarks = pgTable('chip_in_marks', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  drawnThrough: ts('drawn_through').notNull(),
})

/** Servers whose owner turned chipping in off; every other server takes it where its plan does. */
export const chipInClosed = pgTable('chip_in_closed', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => minecraftServers.id),
  closedAt: createdAt(),
})

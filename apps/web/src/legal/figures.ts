// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plan facts the policies state, as they stood on the policies' date (`TERMS_VERSION`). The
 * Terms are an agreement, so they say these in words that don't move with every reading of the
 * plan table; `scripts/legal-figures.test.ts` holds them to the table the control plane enforces,
 * so a plan that changes fails the test until the policies (and their date) change with it.
 */
export interface PlanFigures {
  name: string
  /** Price a month in US cents, VAT included where it applies. */
  priceCents: number
  /** Hours of play included each calendar month (a large server spends two an hour). */
  hours: number
  maxServers: number
  /** Minutes a server keeps running after the last player leaves. */
  sleepsAfterMinutes: number
  /** Days without play before a world rests in storage. */
  restsAfterDays: number
  /** Days without play before a world is deleted; null: kept while the plan lasts. */
  deletedAfterDays: number | null
  /** Daily backups kept. */
  backupsKept: number
  /** Days a deleted server waits in the trash. */
  trashDays: number
  /** Days a world download is kept to fetch. */
  downloadDays: number
}

export const FREE: PlanFigures = {
  name: 'Free',
  priceCents: 0,
  hours: 20,
  maxServers: 1,
  sleepsAfterMinutes: 10,
  restsAfterDays: 14,
  deletedAfterDays: 365,
  backupsKept: 3,
  trashDays: 7,
  downloadDays: 7,
}

export const PLUS: PlanFigures = {
  name: 'Plus',
  priceCents: 1500,
  hours: 100,
  maxServers: 3,
  sleepsAfterMinutes: 15,
  restsAfterDays: 30,
  deletedAfterDays: null,
  backupsKept: 14,
  trashDays: 30,
  downloadDays: 30,
}

/** Days before an unplayed world is deleted that its owner is emailed (`schedules/expiring.ts`). */
export const DELETION_WARNINGS_DAYS = [30, 7] as const

/** What an extra hour of play costs on Plus, in US cents (`domain/account/meter.ts`). */
export const EXTRA_HOUR_CENTS = 25

/** Days a failed renewal keeps the paid plan while the card is fixed (`billing/persistence.ts`). */
export const PAST_DUE_GRACE_DAYS = 7

/**
 * Hours of play, counted as the account page counts them (a large server spends two an hour),
 * below which cancelling in the first 14 days gets everything back, a policy choice. At or past
 * it, only the part not played is refunded, as the law requires.
 */
export const FULL_REFUND_UNDER_HOURS = 30

/** Minutes a player may stand still in game before the server kicks them, by default. */
export const AFK_KICK_MINUTES = 15

/** A price as the policies say it: "$15". */
export const dollars = (cents: number): string =>
  `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

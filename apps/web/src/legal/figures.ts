// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plan facts the policies state, as they stood on the policies' date (`TERMS_VERSION`). The
 * Terms are an agreement, so they say these in words that don't move with every reading of the
 * plan table; `scripts/legal-figures.test.ts` holds them to the table the control plane enforces,
 * so a plan that changes fails the test until the policies (and their date) change with it. Not a
 * plan's price or its hours a month, which move with what a new subscriber is offered: the
 * policies point to the Pricing and checkout pages for those, and state no such figure.
 */
export interface PlanFigures {
  /** The plan's name as the product says it (`planName`). */
  name: string
  /** Hours of play included once, in all, to play on any day; null: none. A large server spends two an hour, the largest four. */
  totalHours: number | null
  /** The most of a month's unused hours that carry into the next month, once; null: none carry. */
  carryHours: number | null
  maxServers: number
  /** Players on a server at once; null: as many as the server's size holds. */
  maxPlayers: number | null
  /** Whether a server may run mods, plugins and modpacks. */
  mods: boolean
  datapacks: boolean
  /** Whether servers come in more than one size. */
  largerSizes: boolean
  /** Whether the owner may allow extra hours, paid for after they are played. */
  extraHours: boolean
  /** The most extra hours a month the plan lets an owner allow; null: no most of its own. */
  mostExtraHours: number | null
  /** Whether the owner sets how long a player may stand still before the game removes them. */
  ownAfkKick: boolean
  /** Whether the plan is also sold as a year, paid once. */
  byYear: boolean
  /** Minutes a server keeps running after the last player leaves. */
  sleepsAfterMinutes: number
  /** Days without play before a world rests in storage. */
  restsAfterDays: number
  /** Days without play before a world is deleted; null: kept while the plan lasts. */
  deletedAfterDays: number | null
  /** Backups taken after play kept: one each time a server sleeps, or each day it plays on. */
  backupsKept: number
  /** Whether a download is also made each week and kept. */
  weeklyDownload: boolean
  /** World downloads a day; null: as many as the owner likes. */
  downloadsPerDay: number | null
  /** Days a deleted server waits in the trash. */
  trashDays: number
  /** Days a world download is kept to fetch. */
  downloadDays: number
}

/**
 * What every paid plan has alike: the policies say these of "a paid plan", so each paid plan
 * takes them from here, and the test holds every one of them to its own row of the plan table.
 */
export const PAID = {
  ownAfkKick: true,
  sleepsAfterMinutes: 15,
  restsAfterDays: 30,
  deletedAfterDays: null,
  backupsKept: 14,
  weeklyDownload: true,
  downloadsPerDay: null,
  trashDays: 30,
  downloadDays: 30,
} as const satisfies Partial<PlanFigures>

/** The free trial: its hours come once, so the policies call it a trial, never a plan that lasts. */
export const FREE: PlanFigures = {
  name: 'Free trial',
  totalHours: 20,
  carryHours: null,
  maxServers: 1,
  maxPlayers: 5,
  mods: false,
  datapacks: false,
  largerSizes: false,
  extraHours: false,
  mostExtraHours: null,
  ownAfkKick: false,
  byYear: false,
  sleepsAfterMinutes: 10,
  restsAfterDays: 14,
  deletedAfterDays: 365,
  backupsKept: 3,
  weeklyDownload: false,
  downloadsPerDay: 1,
  trashDays: 7,
  downloadDays: 7,
}

/** Plain Minecraft for a group of friends. */
export const CORE: PlanFigures = {
  ...PAID,
  name: 'Core',
  totalHours: null,
  carryHours: null,
  maxServers: 1,
  maxPlayers: 5,
  mods: false,
  datapacks: false,
  largerSizes: false,
  extraHours: true,
  mostExtraHours: 60,
  byYear: false,
}

/** Mods, plugins, modpacks and larger servers. */
export const PLUS: PlanFigures = {
  ...PAID,
  name: 'Plus',
  totalHours: null,
  carryHours: 50,
  maxServers: 3,
  maxPlayers: null,
  mods: true,
  datapacks: true,
  largerSizes: true,
  extraHours: true,
  mostExtraHours: null,
  byYear: true,
}

/** Every plan the policies describe, by its key in the plan table: the test holds them to one another. */
export const PLAN_FIGURES: Readonly<Record<string, PlanFigures>> = { free: FREE, core: CORE, plus: PLUS }

/** Days before an unplayed world is deleted that its owner is emailed (`schedules/expiring.ts`). */
export const DELETION_WARNINGS_DAYS = [30, 7] as const

/** What an extra hour of play costs on a paid plan, in US cents (`domain/account/meter.ts`). */
export const EXTRA_HOUR_CENTS = 25

/** Days a failed renewal keeps the paid plan while the card is fixed (`billing/persistence.ts`). */
export const PAST_DUE_GRACE_DAYS = 7

/**
 * Hours of play, counted as the account page counts them (a large server spends two an hour, the largest four),
 * below which cancelling in the first 14 days gets everything back, a policy choice. At or past
 * it, only the part not played is refunded, as the law requires.
 */
export const FULL_REFUND_UNDER_HOURS = 30

/** Minutes a player may stand still in game before the server kicks them, by default. */
export const AFK_KICK_MINUTES = 15

/**
 * Days a server keeps the scrambled network a player joined it from, after their last visit, so a
 * server-list ping from it may wake the server early (`app/edge/known-addresses.ts`). The policy
 * states it, so private tuning may set it lower but never higher.
 */
export const KNOWN_NETWORK_DAYS = 7

/** Days a record of a join to a server is kept, with what it showed going wrong (`app/joins/service.ts`). */
export const JOIN_RECORD_DAYS = 35

/**
 * Minutes, at most, a record of a join keeps the IP address and port the player joined from: only
 * while what the edge saw is matched with what the server saw (`app/joins/service.ts`).
 */
export const JOIN_ADDRESS_MINUTES = 60

/** Days before a year paid at once ends that its owner is emailed (`billing/years.ts`). */
export const YEAR_REMINDER_DAYS = [14, 3] as const

/** A price as the policies say it: "$15". */
export const dollars = (cents: number): string =>
  `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

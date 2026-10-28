// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The numbers that tune how free accounts are linked, how far abuse and money can go, and how room
 * is shared when it runs short, as types and their defaults. A deployment's own come from private
 * configuration, FREE_LINK_TUNING, ABUSE_LIMITS, CAPACITY_TUNING and ECONOMICS_TUNING (`config/load.ts`), installed
 * at startup (`app/tuning.ts`). The defaults here are
 * round, harmless values for development and tests, not a deployment's. Pure.
 */
import { DAY_MS, HOUR_S } from '@blockly/contracts/durations'

/** What two free accounts can have in common, as `domain/account/free-links.ts` scores them. */
export interface LinkSignals {
  mainPlayer: number
  inbox: number
  signedUpClose: number
  network: number
}

/** How free accounts are linked (`domain/account/free-links.ts`). */
export interface FreeLinkTuning {
  /** What each signal weighs in a pair's score. */
  weights: LinkSignals
  /** A pair scoring at least `link` is linked; a group at `medium` is shown, at `high` shares. */
  link: number
  medium: number
  high: number
  /** How far apart two sign-ups still count as close. */
  signedUpCloseMs: number
  /** The least share of a server's play, and the least time, its main player has. */
  mainShare: number
  mainForS: number
  /** How long the network an account signed up from is kept. */
  networkKeptMs: number
}

/** Caps on what one person can do in a while, against stolen cards and guessing. */
export interface AbuseLimits {
  /** Chip-ins a day, in cents: by one payer across every server, and to one server from everyone. */
  chipIn: { payerDayCents: number; serverDayCents: number }
  /** The most extra hours an account may allow a month, before and after a paid renewal. */
  extraCeiling: { untilRenewed: number; renewed: number }
  /** Gifts one account may buy a day, and wrong gift codes it may enter an hour. */
  giftsPerDay: number
  wrongCodesPerHour: number
  /**
   * Wakes of one server an hour that nobody joined, past which a join from a name the server hasn't
   * seen leaves it asleep (`app/edge/service.ts`).
   */
  wakesPerHour: number
  /**
   * How long a server-list ping may not wake a server again after its last such wake went unjoined
   * (`app/edge/ping-wake.ts`), in hours. Anything can ping, a site that lists servers every few
   * minutes included, and must not keep waking a world nobody comes to.
   */
  pingWakeHoldHours: number
  /**
   * How long after a player's join ends the network they joined from may still wake the server
   * with a ping, in days; it is forgotten then (`app/edge/known-addresses.ts`). Long enough to
   * cover a group's usual gap between sessions, short enough that an address handed on to someone
   * else soon stops counting.
   */
  knownAddressDays: number
  /**
   * People one invite link may let in an hour. A link is meant for friends; a leaked one should
   * cost its holder little and its owner nothing. A class or a club joining at once needs more.
   */
  inviteJoinsPerHour: number
  /**
   * What one game server's join reporter may post (`interfaces/runtime/joins.ts`): requests a
   * second, and bytes a request. Past them its posts are refused, and its reporter drops them.
   */
  joinReportsPerSecond: number
  joinReportBytes: number
  /**
   * Worlds one account may bring in a day before there is a server for them
   * (`app/backups/new-world-imports.ts`): each is up to 4 GB, and read on a worker.
   */
  worldUploadsPerDay: number
  /**
   * What the realtime role lets one account open (`interfaces/realtime/server.node.ts`): consoles a
   * minute, across all its browsers, and consoles one browser's connection follows at once. A page
   * about a server opens its console; past either, that console shows nothing new until there is room.
   */
  consoleWatchesPerMinute: number
  consolesPerConnection: number
  /**
   * How long a new account whose email isn't confirmed yet takes a free place, in hours
   * (`countFreeAccounts` in `app/accounts/persistence.ts`). Once confirmed it takes one for good;
   * one never confirmed stops taking one, so sign-up stays open for the people who do confirm.
   */
  unconfirmedPlaceHours: number
}

/** The figures the runtime economics report prices a margin with (`app/runtimes/economics.ts`). */
export interface EconomicsTuning {
  /** The billing provider's fee on an order: a percent of its total, and a fixed amount in cents. */
  paymentFee: { percent: number; fixedCents: number }
  /** What a GB-month of backups in the archive store costs, in cents. */
  archiveGbMonthCents: number
}

/** How room is shared between plans when it runs short (`domain/policy/room.ts`). */
export interface CapacityTuning {
  /** The share of the room for new servers that free plans may fill; paid plans create in all of it. */
  freeShare: number
  /** The share of the running room past which room is tight. */
  tightShare: number
  /** How long a free server nobody is on stays up while room is tight, in minutes. */
  tightIdleMinutes: number
}

export const DEFAULT_FREE_LINK_TUNING: FreeLinkTuning = {
  weights: { mainPlayer: 1, inbox: 1, signedUpClose: 0.1, network: 0.1 },
  link: 0.3,
  medium: 0.6,
  high: 0.95,
  signedUpCloseMs: 2 * DAY_MS,
  mainShare: 0.6,
  mainForS: 2 * HOUR_S,
  networkKeptMs: 3 * DAY_MS,
}

export const DEFAULT_ABUSE_LIMITS: AbuseLimits = {
  chipIn: { payerDayCents: 10000, serverDayCents: 20000 },
  extraCeiling: { untilRenewed: 50, renewed: 200 },
  giftsPerDay: 5,
  wrongCodesPerHour: 5,
  wakesPerHour: 20,
  pingWakeHoldHours: 24,
  knownAddressDays: 7,
  inviteJoinsPerHour: 10,
  joinReportsPerSecond: 10,
  joinReportBytes: 65_536,
  worldUploadsPerDay: 10,
  consoleWatchesPerMinute: 60,
  consolesPerConnection: 10,
  unconfirmedPlaceHours: 24,
}

/** Round figures for development and tests. */
export const DEFAULT_ECONOMICS_TUNING: EconomicsTuning = {
  paymentFee: { percent: 3, fixedCents: 30 },
  archiveGbMonthCents: 1,
}

/** Nothing set aside for paid plans, and room never tight short of full. */
export const DEFAULT_CAPACITY_TUNING: CapacityTuning = {
  freeShare: 1,
  tightShare: 1,
  tightIdleMinutes: 5,
}

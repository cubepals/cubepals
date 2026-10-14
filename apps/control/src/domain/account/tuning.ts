// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The numbers that tune how free accounts are linked, how far abuse and money can go, and how room
 * is shared when it runs short, as types and their defaults. A deployment's own come from private
 * configuration, FREE_LINK_TUNING, ABUSE_LIMITS and CAPACITY_TUNING (`config/load.ts`), installed
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
  /** Wakes the edge asks of one server an hour. */
  wakesPerHour: number
  /**
   * People one invite link may let in an hour. A link is meant for friends; a leaked one should
   * cost its holder little and its owner nothing. A class or a club joining at once needs more.
   */
  inviteJoinsPerHour: number
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
  inviteJoinsPerHour: 10,
}

/** Nothing set aside for paid plans, and room never tight short of full. */
export const DEFAULT_CAPACITY_TUNING: CapacityTuning = {
  freeShare: 1,
  tightShare: 1,
  tightIdleMinutes: 5,
}

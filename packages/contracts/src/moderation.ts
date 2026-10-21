// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moderation, as the API takes and shows it: whether a server has the moderation tools and its chat
 * filter, the warnings, mutes and bans given from Cubepals, and the escalation that picks what a
 * player's next offence gets.
 */

import { z } from 'zod'
import { DAY_MS, HOUR_MS, MINUTE_MS } from './durations.ts'
import { ServerId } from './server.ts'

export const MODERATION_KINDS = ['warn', 'mute', 'ban'] as const
export type ModerationKind = (typeof MODERATION_KINDS)[number]

/** One step of an escalation: a warning, or a mute or ban for so many minutes, or for good (null). */
export interface ModerationStep {
  kind: ModerationKind
  minutes: number | null
}

const HOUR_MINUTES = HOUR_MS / MINUTE_MS
const DAY_MINUTES = DAY_MS / MINUTE_MS

/** The lengths a mute or ban is offered in, shortest first; null is for good. */
export const MODERATION_LENGTHS: readonly (number | null)[] = [
  HOUR_MINUTES,
  DAY_MINUTES,
  7 * DAY_MINUTES,
  30 * DAY_MINUTES,
  null,
]

/**
 * What Blockly gives a player for each offence on a server, first to last: a warning, then an hour
 * and a day without chat, then a week away, then for good. The last step repeats. An owner may set
 * their own (`SetLadderInput`).
 */
export const DEFAULT_LADDER: readonly ModerationStep[] = [
  { kind: 'warn', minutes: null },
  { kind: 'mute', minutes: HOUR_MINUTES },
  { kind: 'mute', minutes: DAY_MINUTES },
  { kind: 'ban', minutes: 7 * DAY_MINUTES },
  { kind: 'ban', minutes: null },
]

/** The longest a timed mute or ban may be: a year. */
const MAX_MINUTES = 365 * DAY_MINUTES

const Step = z
  .object({
    kind: z.enum(MODERATION_KINDS),
    minutes: z.number().int().min(1).max(MAX_MINUTES).nullable(),
  })
  .transform((step) => (step.kind === 'warn' ? { kind: step.kind, minutes: null } : step))

export const SetModerationInput = z.object({
  serverId: ServerId,
  /** The moderation tools: warnings, mutes, bans and helpers. */
  enabled: z.boolean(),
  /** The chat filter, which needs the tools. */
  chatFilter: z.boolean(),
  requestId: z.uuid(),
})

export const PunishInput = z
  .object({
    serverId: ServerId,
    playerUuid: z.uuid(),
    name: z.string().trim().min(1).max(64),
    reason: z.string().trim().max(120),
  })
  .and(Step)

export const LiftInput = z.object({ serverId: ServerId, actionId: z.uuid() })

/** The owner's escalation, or null to go back to Blockly's. */
export const SetLadderInput = z.object({
  serverId: ServerId,
  ladder: z.array(Step).min(1).max(10).nullable(),
})

export interface ModerationActionView {
  id: string
  player: { uuid: string; name: string }
  kind: ModerationKind
  reason: string
  minutes: number | null
  /**
   * `waiting`: it reaches the server when it next starts. `given`: on the server. `over`: a mute
   * or ban whose time is up. `lifting`: being taken back. `lifted`: taken back.
   */
  status: 'waiting' | 'given' | 'over' | 'lifting' | 'lifted'
  /** When a timed mute or ban ends. */
  endsAt: string | null
  at: string
  error: string | null
}

export interface ModerationView {
  /** Whether this server can run the tools: a Paper server, or a plain one that would become one. */
  available: boolean
  enabled: boolean
  chatFilter: boolean
  /** The escalation in force, and whether it is the owner's own. */
  ladder: ModerationStep[]
  ownLadder: boolean
  /** Newest first. */
  actions: ModerationActionView[]
}

/**
 * What a player's next offence gets on the ladder: one step further for each warning, mute or ban
 * they were given and not let off, the last step again once they are past the end.
 */
export function nextStep(
  ladder: readonly ModerationStep[],
  history: ReadonlyArray<Pick<ModerationActionView, 'status'>>,
): ModerationStep {
  const offences = history.filter(
    (action) => action.status !== 'lifted' && action.status !== 'lifting',
  ).length
  return ladder[Math.min(offences, ladder.length - 1)] ?? { kind: 'warn', minutes: null }
}

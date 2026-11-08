// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One person, one set of free hours: each account's email as its inbox reads it and the network it
 * signed up from, the pairs of accounts that look like one person's and why, the group each account
 * was put in and how sure Blockly is of it, and the accounts an admin holds.
 */
import { index, jsonb, pgTable, primaryKey, real, text } from 'drizzle-orm/pg-core'
import { users } from './auth.ts'
import { createdAt, ts } from './columns.ts'

/**
 * An account's email with what only tells its inbox apart dropped (case, Gmail's dots, `+tags`),
 * so aliases of one inbox are found as one; the network it signed up from, for two days; the group
 * of accounts it is linked into; and whether an admin holds its free play.
 */
export const freePlay = pgTable(
  'free_play',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailKey: text('email_key').notNull(),
    /** The network the sign-up came from (an IPv6 one by its /64), a weak signal; cleared after two days. */
    signupNetwork: text('signup_network'),
    /** The first account of the group it is linked into; null when it is in none. */
    groupId: text('group_id'),
    /** How sure Blockly is the group is one person's, in [0, 1]. */
    confidence: real('confidence'),
    /** Set while an admin holds the account: no free server starts or is made. Nothing is deleted. */
    heldAt: ts('held_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('free_play_email_key').on(t.emailKey),
    index('free_play_group').on(t.groupId),
    index('free_play_signup_network').on(t.signupNetwork),
  ],
)

/**
 * Two accounts that look like one person's, `accountId` the one that signed up later: what they
 * have in common (`LinkSignals`, each in [0, 1]) and the score it adds up to. Only pairs scoring
 * enough to link are kept.
 */
export const freeLinks = pgTable(
  'free_links',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    linkedId: text('linked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    score: real('score').notNull(),
    signals: jsonb('signals')
      .$type<{
        mainPlayer: number
        inbox: number
        signedUpClose: number
        network: number
        playersMoved?: number
      }>()
      .notNull(),
    createdAt: createdAt(),
    /** When an admin looked at it, holding or releasing: it no longer raises an alert. */
    reviewedAt: ts('reviewed_at'),
    /** When an admin released it: the two count their free play apart again, for good. */
    releasedAt: ts('released_at'),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.linkedId] }), index('free_links_linked').on(t.linkedId)],
)

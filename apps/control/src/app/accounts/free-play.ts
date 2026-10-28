// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One person, one set of free hours, as an account reads it: its inbox and sign-up network, kept;
 * the accounts whose free play counts as its own, which are those of a group Blockly is sure of
 * (`high`); the links admins are shown; and whether an admin holds it. How groups are scored and
 * written is `free-links.ts`'s, and what Blockly and an admin do with them `free-play-guard.ts`'s.
 * Who counts free play by these is `play-total.ts`.
 */
import { type Queryable, schema } from '@blockly/db'
import { and, count, eq, gte, isNotNull, isNull, ne, or } from 'drizzle-orm'
import { tuning } from '../tuning.ts'
import { loadStanding } from './persistence.ts'

const play = schema.freePlay
const links = schema.freeLinks

/** Why two accounts' free play counts as one: one inbox, or one main player. */
export type LinkedBy = 'email' | 'players'

/**
 * Keeps an account's email as its inbox reads it, and the network it signed up from when known:
 * the other accounts of the same inbox.
 */
export async function keepEmailKey(
  q: Queryable,
  userId: string,
  emailKey: string,
  network: string | null,
): Promise<string[]> {
  await q
    .insert(play)
    .values({ userId, emailKey, signupNetwork: network })
    .onConflictDoUpdate({ target: play.userId, set: { emailKey } })
  const same = await q
    .select({ id: play.userId })
    .from(play)
    .where(and(eq(play.emailKey, emailKey), ne(play.userId, userId)))
  return same.map((row) => row.id)
}

/**
 * Accounts made before their inbox was kept, or put in a group or held before it was, a batch at
 * a time, for `keepEmailKey`.
 */
export async function unkeyedAccounts(
  q: Queryable,
  limit: number,
): Promise<Array<{ id: string; email: string }>> {
  return q
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .leftJoin(play, eq(play.userId, schema.users.id))
    .where(or(isNull(play.userId), eq(play.emailKey, '')))
    .limit(limit)
}

/**
 * The accounts whose free play counts as this one's, itself first, and why: every account of its
 * group, when Blockly is sure the group is one person's, drawing on one set of free hours. Only
 * accounts on Free now: hours someone paid for are nobody's free hours.
 */
export async function freeSharers(
  q: Queryable,
  userId: string,
  now: Date,
): Promise<{ ids: string[]; why: LinkedBy | null }> {
  const [mine] = await q.select().from(play).where(eq(play.userId, userId))
  if (mine?.groupId == null || (mine.confidence ?? 0) < tuning().freeLinks.high)
    return { ids: [userId], why: null }
  const group = await q.select({ id: play.userId }).from(play).where(eq(play.groupId, mine.groupId))
  const ids = [userId]
  for (const { id } of group)
    if (id !== userId && (await loadStanding(q, id, now)).plan === 'free') ids.push(id)
  if (ids.length === 1) return { ids, why: null }
  const own = await q
    .select({ signals: links.signals })
    .from(links)
    .where(and(isNull(links.releasedAt), or(eq(links.accountId, userId), eq(links.linkedId, userId))))
  return { ids, why: own.some((row) => row.signals.inbox >= 1) ? 'email' : 'players' }
}

/** Links in groups admins are shown (`medium` and up) that nobody has held or released yet. */
export async function unreviewedLinks(q: Queryable): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(links)
    .innerJoin(play, eq(play.userId, links.accountId))
    .where(
      and(
        isNull(links.reviewedAt),
        isNull(links.releasedAt),
        gte(play.confidence, tuning().freeLinks.medium),
      ),
    )
  return row?.n ?? 0
}

/** Whether an admin holds this account's free play: none of its free servers starts or is made. */
export async function freeHeld(q: Queryable, userId: string): Promise<boolean> {
  const [row] = await q
    .select({ heldAt: play.heldAt })
    .from(play)
    .where(and(eq(play.userId, userId), isNotNull(play.heldAt)))
  return row !== undefined
}

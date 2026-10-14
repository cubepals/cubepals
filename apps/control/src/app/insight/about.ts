// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What every event about an account carries to PostHog besides its own properties: `internal`
 * when the account is ours (a platform admin's, or on Cubepals' own domain, which the production
 * checks' accounts are), so every count can leave it out; and where the account came from, as the
 * link that brought it said at sign-up (`signup_source`, the link's `utm_source` or `ref`, with its
 * `signup_medium` and `signup_campaign`), so a server made traces back to its owner's channel.
 * Nothing that names anyone: no email, no name, no address. An account that isn't ours carries no
 * `internal` at all, so events read as they always have.
 */
import { ownEmail } from '@blockly/contracts'
import { type Queryable, schema } from '@blockly/db'
import { eq, inArray } from 'drizzle-orm'

export type AccountMarks = Record<string, string | boolean>

/** Each account's marks, by its id; an account not found has none. */
export async function marksOf(q: Queryable, userIds: readonly string[]): Promise<Map<string, AccountMarks>> {
  if (userIds.length === 0) return new Map()
  const standing = schema.accountStanding
  const rows = await q
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      admin: schema.platformAdmins.userId,
      source: standing.signupSource,
      medium: standing.signupMedium,
      campaign: standing.signupCampaign,
    })
    .from(schema.users)
    .leftJoin(schema.platformAdmins, eq(schema.platformAdmins.userId, schema.users.id))
    .leftJoin(standing, eq(standing.userId, schema.users.id))
    .where(inArray(schema.users.id, [...new Set(userIds)]))
  return new Map(
    rows.map((row) => [
      row.userId,
      {
        ...(row.admin !== null || ownEmail(row.email) ? { internal: true } : {}),
        ...(row.source === null ? {} : { signup_source: row.source }),
        ...(row.medium === null ? {} : { signup_medium: row.medium }),
        ...(row.campaign === null ? {} : { signup_campaign: row.campaign }),
      },
    ]),
  )
}

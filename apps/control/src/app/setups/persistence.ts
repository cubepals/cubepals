// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Queryable, schema } from '@blockly/db'
import { and, eq, inArray } from 'drizzle-orm'

const checks = schema.packChecks

export interface PackCheck {
  /** What choosing it is told; null when Blockly runs it. */
  refusal: string | null
  checkedAt: Date
}

/** What checking these packs found, by project; one never checked is missing. */
export async function loadPackChecks(
  q: Queryable,
  catalog: string,
  projectIds: readonly string[],
): Promise<Map<string, PackCheck>> {
  if (projectIds.length === 0) return new Map()
  const rows = await q
    .select()
    .from(checks)
    .where(and(eq(checks.catalog, catalog), inArray(checks.projectId, [...projectIds])))
  return new Map(rows.map((row) => [row.projectId, { refusal: row.refusal, checkedAt: row.checkedAt }]))
}

export async function savePackCheck(
  q: Queryable,
  catalog: string,
  projectId: string,
  refusal: string | null,
  at: Date,
): Promise<void> {
  await q
    .insert(checks)
    .values({ catalog, projectId, refusal, checkedAt: at })
    .onConflictDoUpdate({ target: [checks.catalog, checks.projectId], set: { refusal, checkedAt: at } })
}

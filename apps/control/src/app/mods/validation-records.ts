// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Temporary validation resources remain distinguishable from unowned player servers after a crash. */
import { type Queryable, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'

export async function validationResource(q: Queryable, runtimeId: string) {
  const runs = schema.modValidationRuns
  const checks = schema.modValidations
  const [record] = await q
    .select({
      key: runs.key,
      plan: checks.plan,
      createdAt: checks.createdAt,
      state: checks.state,
      leaseUntil: runs.leaseUntil,
      finishedAt: runs.finishedAt,
      currentId: checks.runtimeId,
    })
    .from(runs)
    .innerJoin(checks, eq(checks.key, runs.key))
    .where(eq(runs.id, runtimeId))
  if (record === undefined) return null
  return {
    key: record.key,
    plan: record.plan,
    createdAt: record.createdAt,
    leaseUntil: record.leaseUntil,
    state: record.finishedAt === null && record.currentId === runtimeId ? record.state : 'unavailable',
  }
}

export function validationActive(
  record: Awaited<ReturnType<typeof validationResource>>,
  now = new Date(),
): boolean {
  return (
    record !== null && record.state === 'checking' && record.leaseUntil !== null && record.leaseUntil > now
  )
}

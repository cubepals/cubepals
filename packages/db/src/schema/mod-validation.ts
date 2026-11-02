// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Cached runtime checks and their temporary resources, retained across worker crashes for cleanup. */
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import type { ModValidationPlanJson } from '../json.ts'
import { createdAt, ts } from './columns.ts'

export const modValidations = pgTable(
  'mod_validations',
  {
    key: text().primaryKey(),
    plan: jsonb().$type<ModValidationPlanJson>().notNull(),
    state: text().$type<'checking' | 'verified' | 'blocked' | 'unavailable'>().notNull().default('checking'),
    runtimeId: uuid('runtime_id').notNull(),
    handle: text(),
    leaseUntil: ts('lease_until'),
    message: text(),
    evidence: jsonb().$type<{ image: string; log: string[]; installed: string[] }>(),
    createdAt: createdAt(),
    checkedAt: ts('checked_at'),
  },
  (table) => [index('mod_validations_runtime').on(table.runtimeId)],
)

/** Content-addressed compiler decisions; no download links or user identifiers are recorded. */
export const modCompilations = pgTable('mod_compilations', {
  key: text().primaryKey(),
  evidence: jsonb()
    .$type<{
      target: { gameVersion: string; loader?: string; loaders: readonly string[]; java?: number }
      requested: ReadonlyArray<{ projectId: string; versionId?: string }>
      selected: Array<{ sha512: string; name: string }>
      omitted: Array<{
        kind: string
        from: string
        projectId: string
        loader: string
        artifactSha512: string
      }>
      conflicts: unknown[]
      unknown: string[]
    }>()
    .notNull(),
  createdAt: createdAt(),
})

/** Every attempt retains its own ownership identity, even when provisioning returns after a timeout. */
export const modValidationRuns = pgTable(
  'mod_validation_runs',
  {
    id: uuid().primaryKey(),
    key: text()
      .notNull()
      .references(() => modValidations.key),
    leaseUntil: ts('lease_until').notNull(),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
  },
  (table) => [index('mod_validation_runs_key').on(table.key)],
)

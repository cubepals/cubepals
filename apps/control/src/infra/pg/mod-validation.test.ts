// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Runtime evidence declarations must describe the actual release tables, keys, defaults and indexes. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

const { modCompilations, modValidationRuns, modValidations } = schema

test('every temporary attempt retains a required lease and references its configuration evidence', () => {
  const config = getTableConfig(modValidationRuns)
  const [reference] = config.foreignKeys.map((key) => key.reference())
  expect(reference?.foreignTable).toBe(modValidations)
  expect(reference?.columns).toEqual([modValidationRuns.key])
  expect(modValidationRuns.leaseUntil.notNull).toBe(true)
  expect(modValidationRuns.finishedAt.notNull).toBe(false)
  expect(config.indexes.map((index) => index.config.name)).toContain('mod_validation_runs_key')
})

describe.skipIf(!hasDatabase)('runtime evidence in the release schema', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })
  test('the ORM names, string defaults and indexes match the migrated database', async () => {
    for (const table of [modValidations, modValidationRuns, modCompilations]) {
      const config = getTableConfig(table)
      const { rows } = await h.db.execute<{ column_name: string; column_default: string | null }>(
        sql`SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${config.name}`,
      )
      expect(rows.map((row) => row.column_name).sort()).toEqual(
        config.columns.map((column) => column.name).sort(),
      )
      for (const column of config.columns) {
        if (typeof column.default !== 'string') continue
        const expression = rows.find((row) => row.column_name === column.name)?.column_default
        expect(expression).toBeString()
        // The expression comes only from the release migration in this disposable database.
        const actual = await h.db.execute(sql.raw(`SELECT ${expression} AS value`))
        expect(actual.rows[0]?.value).toBe(column.default)
      }
      const indexes = await h.db.execute<{ name: string }>(
        sql`SELECT index_relation.relname AS name FROM pg_index AS entry JOIN pg_class AS table_relation ON table_relation.oid = entry.indrelid JOIN pg_class AS index_relation ON index_relation.oid = entry.indexrelid WHERE table_relation.relname = ${config.name} AND NOT entry.indisprimary`,
      )
      expect(indexes.rows.map((row) => row.name).sort()).toEqual(
        config.indexes.map((index) => index.config.name ?? '').sort(),
      )
    }
  }, 30_000)
})

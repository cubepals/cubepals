// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Materialize the actual Drizzle constraints, including the import progress column. */
import { expect, test } from 'bun:test'
import { is, Table } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as artifacts from './artifacts.ts'

test('artifact records have named, distinct indexes and import progress remains optional JSON', () => {
  const names = new Set<string>()
  for (const table of Object.values(artifacts)) {
    if (!is(table, Table)) continue
    const config = getTableConfig(table)
    for (const index of config.indexes) {
      expect(index.config.name).toBeDefined()
      expect(names.has(index.config.name ?? '')).toBe(false)
      names.add(index.config.name ?? '')
    }
    for (const key of config.foreignKeys) expect(key.reference().columns.length).toBeGreaterThan(0)
  }
  const column = artifacts.worldImports.progress
  expect(column.dataType).toBe('json')
  expect(column.notNull).toBe(false)
})

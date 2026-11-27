// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Materialize the actual Drizzle constraints: every artifact index named, and no name used twice. */
import { expect, test } from 'bun:test'
import { is, Table } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as artifacts from './artifacts.ts'

test('artifact records have named, distinct indexes', () => {
  const names = new Set<string>()
  for (const table of Object.values(artifacts)) {
    if (!is(table, Table)) continue
    for (const index of getTableConfig(table).indexes) {
      expect(index.config.name).toBeDefined()
      expect(names.has(index.config.name ?? '')).toBe(false)
      names.add(index.config.name ?? '')
    }
  }
})

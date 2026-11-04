// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { STATEMENT_CHARS, shapeOf } from './statement.ts'

describe('a query’s shape', () => {
  test('is one name for one query, however many values its lists hold', () => {
    const one = shapeOf('select * from "joins" where "server_id" in ($1) and "at" > $2')
    const three = shapeOf('select * from "joins" where "server_id" in ($1, $2, $3) and "at" > $4')
    expect(one?.name).toBe(three?.name as string)
    expect(one?.name).toMatch(/^q:[0-9a-f]{12}$/)
    expect(one?.operation).toBe('SELECT')
    expect(one?.text).toBe('select * from "joins" where "server_id" in ($n) and "at" > $n')
  })

  test('and however many rows an insert writes at once', () => {
    const two = shapeOf('insert into "diagnostics" ("at", "ms") values ($1, $2), ($3, $4)')
    const one = shapeOf('insert into "diagnostics" ("at", "ms") values ($1, $2)')
    expect(two?.name).toBe(one?.name as string)
    expect(two?.operation).toBe('INSERT')
  })

  test('keeps no literal a query built by hand carried, and tells two queries apart', () => {
    const typed = shapeOf("select 1 from users where email = 'someone@example.test' limit 10")
    expect(typed?.text).toBe("select ? from users where email = '?' limit ?")
    expect(typed?.text).not.toContain('someone')
    expect(shapeOf('select 1 from users')?.name).not.toBe(shapeOf('select 1 from joins')?.name as string)
  })

  test('is the same however the statement is spaced, and keeps numbers inside names', () => {
    const spaced = shapeOf('SELECT  "t1"."col_2"\n  FROM   "t1"')
    expect(spaced?.text).toBe('SELECT "t1"."col_2" FROM "t1"')
    expect(spaced?.name).toBe(shapeOf('SELECT "t1"."col_2" FROM "t1"')?.name as string)
  })

  test('is cut at its length, and there is none for no text', () => {
    expect(shapeOf(`select ${'x, '.repeat(2000)}y`)?.text.length).toBe(STATEMENT_CHARS)
    expect(shapeOf(undefined)).toBeNull()
    expect(shapeOf('   ')).toBeNull()
  })
})

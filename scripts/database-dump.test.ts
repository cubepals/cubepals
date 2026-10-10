// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The database dump's own decisions, on stand-in values: which values a run needs, the dump's key,
 * reading pg_dump's version and pg_restore's list, the size line, and what an error may print.
 * The dump itself runs against the dev stack (docs/production.md § Database dumps).
 */
import { describe, expect, test } from 'bun:test'
import { configOf, dumpKey, entriesIn, majorOf, megabytes, overLimit, redact } from './database-dump.ts'

const values = {
  DATABASE_URL: 'postgresql://blockly.projectref:p%40ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres',
  DUMP_S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  DUMP_S3_BUCKET: 'blockly-prod-database-dumps',
  DUMP_S3_ACCESS_KEY_ID: 'stand-in-key-id',
  DUMP_S3_SECRET_ACCESS_KEY: 'stand-in-secret',
}

describe('the values', () => {
  test('none set is a dump not set up yet, not a failure', () => {
    expect(configOf({})).toBeNull()
  })

  test('some set and some not names the missing ones', () => {
    expect(() => configOf({ ...values, DUMP_S3_BUCKET: '', DUMP_S3_SECRET_ACCESS_KEY: undefined })).toThrow(
      'DUMP_S3_BUCKET, DUMP_S3_SECRET_ACCESS_KEY not set.',
    )
  })

  test('the region defaults to auto and the size line to 400 MB', () => {
    const config = configOf(values)
    expect(config?.store.region).toBe('auto')
    expect(config?.store.bucket).toBe('blockly-prod-database-dumps')
    expect(config?.limitBytes).toBe(400 * 1024 * 1024)
    expect(configOf({ ...values, DUMP_SIZE_LIMIT_MB: '0.5' })?.limitBytes).toBe(512 * 1024)
    expect(() => configOf({ ...values, DUMP_SIZE_LIMIT_MB: 'lots' })).toThrow('DUMP_SIZE_LIMIT_MB')
  })
})

describe('the dump', () => {
  test('its key is the UTC time, so keys sort oldest first', () => {
    expect(dumpKey(new Date('2026-10-10T03:30:05.123Z'))).toBe('blockly-2026-10-10T03-30-05Z.dump')
    const later = dumpKey(new Date('2026-10-10T03:30:05Z'))
    const earlier = dumpKey(new Date('2026-09-30T23:59:59Z'))
    expect([later, earlier].sort()).toEqual([earlier, later])
  })

  test("pg_dump's major version is read from its version line", () => {
    expect(majorOf('pg_dump (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)')).toBe(17)
    expect(majorOf('pg_dump (PostgreSQL) 18.3')).toBe(18)
    expect(majorOf('command not found')).toBeNull()
  })

  test("pg_restore's list counts its entries and not its comments", () => {
    const list = [
      ';',
      '; Archive created at 2026-10-10 03:30:05 UTC',
      ';     dbname: blockly',
      ';',
      '5; 2615 16389 SCHEMA - drizzle blockly',
      '230; 1259 16390 TABLE public accounts blockly',
      '',
    ].join('\n')
    expect(entriesIn(list)).toBe(2)
    expect(entriesIn(';\n; nothing\n')).toBe(0)
  })
})

describe('the size line', () => {
  test('under it, nothing; past it, the size, the line and what to do', () => {
    const limit = 400 * 1024 * 1024
    expect(overLimit(limit, limit)).toBeNull()
    const over = overLimit(420 * 1024 * 1024, limit)
    expect(over).toContain('420.0 MB, past the 400.0 MB line')
    expect(over).toContain('500 MB')
    expect(megabytes(1024 * 1024 * 7.25)).toBe('7.3 MB')
  })
})

describe('what an error may print', () => {
  test("never the database's user, password or host, the store's account, or an address", () => {
    const error =
      'connection to server at "aws-0-eu-central-1.pooler.supabase.com" (3.65.151.229), port 5432 failed: ' +
      'FATAL: password authentication failed for user "blockly.projectref" (p@ss) ' +
      'and https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/ answered 403'
    const out = redact(error, [
      values.DATABASE_URL,
      values.DUMP_S3_ENDPOINT,
      values.DUMP_S3_SECRET_ACCESS_KEY,
    ])
    for (const part of ['pooler.supabase.com', 'projectref', 'p@ss', '3.65.151.229', '0123456789abcdef'])
      expect(out).not.toContain(part)
    expect(out).toContain('port 5432 failed')
    expect(out).toContain('answered 403')
  })

  test('a malformed password still has the host taken out', () => {
    const url = 'postgres://user:50%zz@db.example.test:5432/blockly'
    expect(redact('db.example.test refused user with 50%zz', [url])).toBe(
      '<redacted> refused <redacted> with <redacted>',
    )
  })

  test('a value that is not a URL is taken out whole', () => {
    expect(redact('key stand-in-secret refused', ['stand-in-secret'])).toBe('key <redacted> refused')
  })
})

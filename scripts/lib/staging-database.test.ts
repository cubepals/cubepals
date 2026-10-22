// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which database staging uses and the URL the apps take for it: Fly's by default, Supabase's when
 * STAGING_DATABASE says so. The password is derived from the auth secret, so a state without one
 * agrees with the state that made the database.
 */
import { afterEach, expect, test } from 'bun:test'
import { databaseKind, privateDatabaseUrl } from './staging-database.ts'

const kept = { kind: process.env.STAGING_DATABASE, url: process.env.STAGING_DATABASE_URL }
afterEach(() => {
  for (const [name, value] of [
    ['STAGING_DATABASE', kept.kind],
    ['STAGING_DATABASE_URL', kept.url],
  ] as const)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
})

test('staging is on Fly unless the variable names Supabase', () => {
  delete process.env.STAGING_DATABASE
  expect(databaseKind()).toBe('fly')
  process.env.STAGING_DATABASE = 'supabase'
  expect(databaseKind()).toBe('supabase')
  process.env.STAGING_DATABASE = ''
  expect(databaseKind()).toBe('fly')
})

test('the apps reach the Fly database over Flycast with a password derived from the auth secret', () => {
  delete process.env.STAGING_DATABASE
  const url = new URL(privateDatabaseUrl({ authSecret: 'one' }))
  expect(url.host).toBe('bly-staging-db.flycast:5432')
  expect(url.pathname).toBe('/blockly')
  expect(url.password).not.toBe('')
  expect(privateDatabaseUrl({ authSecret: 'one' })).toBe(privateDatabaseUrl({ authSecret: 'one' }))
  expect(privateDatabaseUrl({ authSecret: 'two' })).not.toBe(privateDatabaseUrl({ authSecret: 'one' }))
  // A password kept in the state wins, so a rotated secret doesn't lock the database out.
  expect(new URL(privateDatabaseUrl({ authSecret: 'two', databasePassword: 'kept' })).password).toBe('kept')
})

test('Supabase is the variable first, then the state', () => {
  process.env.STAGING_DATABASE = 'supabase'
  process.env.STAGING_DATABASE_URL = 'postgres://from-env'
  expect(privateDatabaseUrl({ authSecret: 'one', databaseUrl: 'postgres://from-state' })).toBe(
    'postgres://from-env',
  )
  delete process.env.STAGING_DATABASE_URL
  expect(privateDatabaseUrl({ authSecret: 'one', databaseUrl: 'postgres://from-state' })).toBe(
    'postgres://from-state',
  )
})

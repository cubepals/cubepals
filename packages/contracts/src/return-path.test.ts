// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The path to go to next, read the way the URL standard reads it: paths on this site are kept
 * as the browser would go to them, and anything that would leave it is refused.
 */

import { describe, expect, test } from 'bun:test'
import { sameSitePath } from './return-path.ts'

describe('a place to go next', () => {
  test('keeps a path on this site, its query and fragment with it', () => {
    expect(sameSitePath('/servers')).toBe('/servers')
    expect(sameSitePath('/servers/new?pack=abc&term=year')).toBe('/servers/new?pack=abc&term=year')
    expect(sameSitePath('/account#billing')).toBe('/account#billing')
    expect(sameSitePath('/servers?tab=worlds#latest')).toBe('/servers?tab=worlds#latest')
  })

  test('gives the path as the browser would read it', () => {
    expect(sameSitePath('/servers/../account')).toBe('/account')
    expect(sameSitePath('/servers/./new')).toBe('/servers/new')
    expect(sameSitePath('/a b')).toBe('/a%20b')
    // Encoded characters stay encoded: they are part of the path, never read as its start.
    expect(sameSitePath('/%2F%2Fexample.test')).toBe('/%2F%2Fexample.test')
    expect(sameSitePath('/%09/example.test')).toBe('/%09/example.test')
    expect(sameSitePath('/%5Cexample.test')).toBe('/%5Cexample.test')
  })

  test('refuses a path with a tab, a line break or another control character', () => {
    for (const path of [
      '/\t/example.test',
      '/\n/example.test',
      '/\r/example.test',
      '/\r\n/example.test',
      '/\t\\example.test',
      '/servers\u0000',
      '/servers\u007f',
    ])
      expect(sameSitePath(path)).toBeNull()
  })

  test('refuses a backslash anywhere', () => {
    for (const path of ['/\\example.test', '/servers\\new', '/\\/example.test'])
      expect(sameSitePath(path)).toBeNull()
  })

  test('refuses another site, however it is written', () => {
    for (const path of [
      '//example.test',
      '//example.test/servers',
      '/..//example.test',
      '/.//example.test',
      '/servers/..//example.test',
      '/%2e%2e//example.test',
      'https://example.test/',
      'javascript:alert(1)',
      'servers',
      ' /servers',
      '',
    ])
      expect(sameSitePath(path)).toBeNull()
  })

  test('refuses a path that arrived encoded and decodes to another site', () => {
    for (const encoded of [
      '%2F%09%2Fexample.test',
      '%2F%0A%2Fexample.test',
      '%2F%2Fexample.test',
      '%2F%5Cexample.test',
    ])
      expect(sameSitePath(new URLSearchParams(`next=${encoded}`).get('next'))).toBeNull()
  })

  test('refuses nothing at all', () => {
    expect(sameSitePath(null)).toBeNull()
    expect(sameSitePath(undefined)).toBeNull()
  })
})

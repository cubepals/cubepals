// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Redirect contracts over generated paths: accepted destinations stay local and ambiguous input is refused. */

import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { sameSitePath } from './return-path.ts'

const properties = { seed: 0x51a7e, numRuns: 200, includeErrorInReport: true }
const segment = fc.stringMatching(/^[a-zA-Z0-9_-]{1,24}$/)

test('every accepted redirect stays on the requesting origin and is stable when checked again', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (tail) => {
      for (const candidate of [tail, `/${tail}`, `//${tail}`]) {
        const accepted = sameSitePath(candidate)
        if (accepted === null) continue
        expect(new URL(accepted, 'https://cubepals.com').origin).toBe('https://cubepals.com')
        expect(accepted.startsWith('/')).toBe(true)
        expect(accepted.startsWith('//')).toBe(false)
        expect(sameSitePath(accepted)).toBe(accepted)
      }
    }),
    properties,
  )
})

test('ordinary paths preserve query data and fragments exactly', () => {
  fc.assert(
    fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), segment, segment, (parts, query, hash) => {
      const path = `/${parts.join('/')}?next=${query}#${hash}`
      expect(sameSitePath(path)).toBe(path)
    }),
    properties,
  )
})

test('a control character or backslash at any position makes a path unfit for a redirect', () => {
  const unread = fc.oneof(
    fc.integer({ min: 0, max: 31 }).map(String.fromCharCode),
    fc.integer({ min: 127, max: 159 }).map(String.fromCharCode),
    fc.constant('\\'),
  )
  fc.assert(
    fc.property(segment, unread, fc.nat(), (part, character, offset) => {
      const path = `/${part}/account`
      const at = offset % (path.length + 1)
      expect(sameSitePath(path.slice(0, at) + character + path.slice(at))).toBeNull()
    }),
    properties,
  )
})

test('authority syntax stays forbidden after dot-segment normalization', () => {
  fc.assert(
    fc.property(segment, (host) => {
      for (const prefix of ['//', '/..//', '/%2e%2e//', '/servers/..//']) {
        expect(sameSitePath(`${prefix}${host}.invalid/account`)).toBeNull()
      }
    }),
    properties,
  )
})

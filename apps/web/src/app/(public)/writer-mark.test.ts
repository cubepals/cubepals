// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { markOf } from './writer-mark'

/** Seeds as the API gives them: a hash of an account's id. */
const seed = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32)

describe("a note writer's mark", () => {
  test('is the same for the same seed, every time', () => {
    expect(markOf(seed('account-1'))).toEqual(markOf(seed('account-1')))
    expect(markOf('a-player')).toEqual(markOf('a-player'))
  })

  test('tells writers apart', () => {
    const marks = new Set(Array.from({ length: 100 }, (_, i) => JSON.stringify(markOf(seed(`account-${i}`)))))
    expect(marks.size).toBeGreaterThan(90)
    expect(markOf(seed('account-1'))).not.toEqual(markOf(seed('account-2')))
  })

  test("takes only the site's own colours", () => {
    for (let i = 0; i < 50; i++) expect(markOf(seed(`account-${i}`)).ink).toMatch(/^var\(--[a-z-]+\)$/)
  })
})

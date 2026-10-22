// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { pinOf, repin } from './geyser.ts'

const dockerfile = readFileSync('apps/edge/Dockerfile', 'utf8')

describe('the Geyser pin', () => {
  test('is found in the edge image, with a hash of the right length', () => {
    const pin = pinOf(dockerfile)
    expect(pin).not.toBeNull()
    expect(pin?.build).toBeGreaterThan(0)
  })

  test('a bump changes the three lines and nothing else', () => {
    const next = { version: '2.13.0', build: 1300, sha256: 'a'.repeat(64) }
    const bumped = repin(dockerfile, next)
    expect(pinOf(bumped)).toEqual(next)
    const changed = bumped.split('\n').filter((line, i) => line !== dockerfile.split('\n')[i])
    expect(changed).toHaveLength(3)
  })
})

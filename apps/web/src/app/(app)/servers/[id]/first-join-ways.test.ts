// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { firstJoinWays, onPhone } from './first-join-ways'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; RMP2102) AppleWebKit/537.36 Chrome/153.0 Safari/537.36'
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'

describe('the ways to join a new server', () => {
  test('a server Bedrock can’t join gives Java Edition’s way alone, on any device', () => {
    expect(firstJoinWays(false, false)).toEqual([expect.stringContaining('Java Edition')])
    expect(firstJoinWays(false, true)).toEqual(firstJoinWays(false, false))
  })

  test('with Bedrock on, a phone reads its own way first, and a computer Java’s', () => {
    const [phoneFirst] = firstJoinWays(true, true)
    const [computerFirst] = firstJoinWays(true, false)
    expect(phoneFirst).toContain('On a phone')
    expect(phoneFirst).toContain('port 19132')
    expect(computerFirst).toContain('Java Edition')
    expect(firstJoinWays(true, true)).toHaveLength(2)
  })

  test('phones and tablets are told apart from computers by the browser’s own word', () => {
    expect(onPhone(IPHONE)).toBe(true)
    expect(onPhone(ANDROID)).toBe(true)
    expect(onPhone(MAC)).toBe(false)
  })
})

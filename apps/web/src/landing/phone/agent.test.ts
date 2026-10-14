// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import { describe, expect, test } from 'bun:test'
import { PHONE_AGENT, PHONE_HINT } from './agent'

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36'
const FIREFOX_PHONE = 'Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'
// An iPad's Safari asks for the desktop site, and says it is a Mac.
const IPAD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

/** As the rewrite matches a header: the whole of its value. */
const matches = (pattern: string, value: string) => new RegExp(`^${pattern}$`).test(value)

describe('telling a phone apart', () => {
  test('a phone is a phone, whatever its browser', () => {
    for (const agent of [IPHONE, ANDROID_PHONE, FIREFOX_PHONE]) expect(matches(PHONE_AGENT, agent)).toBe(true)
  })

  test('a tablet and a computer are not', () => {
    for (const agent of [IPAD, ANDROID_TABLET, DESKTOP]) expect(matches(PHONE_AGENT, agent)).toBe(false)
  })

  test('Chromium says which it is', () => {
    expect(matches(PHONE_HINT, '?1')).toBe(true)
    expect(matches(PHONE_HINT, '?0')).toBe(false)
  })
})

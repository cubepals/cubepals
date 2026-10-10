// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { checkoutHref, checkoutOf } from './checkout.ts'

describe('the way to a payment page', () => {
  test('goes through the checkout page, and comes back as it was asked', () => {
    const href = checkoutHref({ plan: 'plus', reason: 'modpack', next: '/servers/new?pack=abc' })
    expect(href).toBe('/checkout?plan=plus&reason=modpack&next=%2Fservers%2Fnew%3Fpack%3Dabc')
    const url = new URL(href, 'https://example.test')
    expect(url.pathname).toBe('/checkout')
    expect(checkoutOf(url.searchParams)).toEqual({
      plan: 'plus',
      reason: 'modpack',
      next: '/servers/new?pack=abc',
    })
  })

  test('never sends anyone to another site afterwards', () => {
    for (const away of ['//evil.test/x', '/\\evil.test', 'https://evil.test/']) {
      expect(checkoutHref({ plan: 'plus', reason: 'account', next: away })).toBe(
        '/checkout?plan=plus&reason=account',
      )
      expect(checkoutOf(new URLSearchParams({ plan: 'plus', next: away }))).toEqual({
        plan: 'plus',
        reason: 'account',
      })
    }
  })

  test('an unknown reason is the account page’s, and no plan is no checkout', () => {
    expect(checkoutOf(new URLSearchParams({ plan: 'plus', reason: 'bribe' }))?.reason).toBe('account')
    expect(checkoutOf(new URLSearchParams({ reason: 'pricing' }))).toBeNull()
  })
})

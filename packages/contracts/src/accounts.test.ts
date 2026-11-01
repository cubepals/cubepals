// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** What a checkout is asked with: the plan, why it was reached for, and where to come back to. */
import { describe, expect, test } from 'bun:test'
import { CheckoutInput, UPGRADE_REASONS } from './accounts.ts'
import { TERMS_VERSION } from './agreements.ts'

const consent = { terms: TERMS_VERSION, startNow: true as const }

describe('a checkout', () => {
  test('may be reached from a free trial’s end, and says so', () => {
    expect(UPGRADE_REASONS).toContain('trial_over')
    expect(
      CheckoutInput.parse({ plan: 'core', reason: 'trial_over', consent, next: '/servers/srv_1' }),
    ).toEqual({
      plan: 'core',
      term: 'month',
      reason: 'trial_over',
      consent,
      next: '/servers/srv_1',
    })
  })

  test('comes back only to a page on this site, and says the account where no reason is known', () => {
    expect(
      CheckoutInput.safeParse({ plan: 'core', consent, next: 'https://elsewhere.example/' }).success,
    ).toBe(false)
    expect(CheckoutInput.safeParse({ plan: 'core', consent, reason: 'because' }).success).toBe(false)
    expect(CheckoutInput.parse({ plan: 'core', consent }).reason).toBe('account')
  })
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { orderMoney } from './withdrawals.ts'

test('an amount is said in the currency its order charged, on the page as in the emails', () => {
  expect(orderMoney(1500, 'usd')).toBe('$15.00')
  expect(orderMoney(420, 'USD')).toBe('$4.20')
  expect(orderMoney(1200, 'eur')).toBe('EUR 12.00')
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { entitlementsFor, entitlementsOf } from './entitlements.ts'
import { newStanding } from './standing.ts'

const SOLD = { priceCents: 700, includedUnits: 90, mostExtraUnits: 12 }

describe('a plan with the terms its subscription was sold with', () => {
  test('takes their price, hours and cap, and keeps the rest of the plan', () => {
    const core = entitlementsFor('core')
    expect(entitlementsFor('core', {}, SOLD)).toEqual({
      ...core,
      monthlyPriceCents: 700,
      includedUnits: 90,
      mostExtraUnits: 12,
    })
  })

  test('keeps the plan’s own cap where they set none', () => {
    const plus = entitlementsFor('plus')
    expect(entitlementsFor('plus', {}, { ...SOLD, mostExtraUnits: null }).mostExtraUnits).toBe(
      plus.mostExtraUnits,
    )
    expect(entitlementsFor('core', {}, { ...SOLD, mostExtraUnits: null }).mostExtraUnits).toBe(
      entitlementsFor('core').mostExtraUnits,
    )
  })

  test('an admin’s hours win over them', () => {
    expect(entitlementsFor('core', { includedUnits: 300 }, SOLD).includedUnits).toBe(300)
  })

  test('a plan without a monthly block has nothing for them to replace', () => {
    expect(entitlementsFor('free', {}, SOLD)).toEqual(entitlementsFor('free'))
  })

  test('a standing gives them with its plan and limits', () => {
    const standing = {
      ...newStanding('user'),
      plan: 'core',
      soldWith: SOLD,
      limitOverrides: { maxServers: 2 },
    }
    expect(entitlementsOf(standing)).toMatchObject({
      includedUnits: 90,
      monthlyPriceCents: 700,
      maxServers: 2,
    })
    expect(entitlementsOf({ ...newStanding('user'), plan: 'core' })).toEqual(entitlementsFor('core'))
  })
})

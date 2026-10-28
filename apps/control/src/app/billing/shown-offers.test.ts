// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { PublicOffer } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { ShownOffers, shownOffersOf } from './shown-offers.ts'

const CORE: PublicOffer = { plan: 'core', priceCents: 700, includedHours: 90 }

describe('the offers the pricing page shows', () => {
  test('are read once a minute, however often and however many ask', async () => {
    let reads = 0
    let now = 0
    const shown = new ShownOffers(
      async () => {
        reads += 1
        return [{ ...CORE, priceCents: 700 + reads }]
      },
      () => now,
    )
    const [a, b] = await Promise.all([shown.read(), shown.read()])
    expect(a).toEqual(b)
    now = MINUTE_MS - 1
    expect(await shown.read()).toEqual(a)
    expect(reads).toBe(1)
    now = MINUTE_MS
    expect((await shown.read())[0]?.priceCents).toBe(702)
    expect(reads).toBe(2)
  })

  test('are none when a read fails, so the plan table stands, and are read again at once', async () => {
    let fail = true
    const shown = new ShownOffers(
      async () => {
        if (fail) throw new Error('database away')
        return [CORE]
      },
      () => 0,
    )
    expect(await shown.read()).toEqual([])
    fail = false
    expect(await shown.read()).toEqual([CORE])
  })

  test('are one cache for each billing service, shared by every caller', () => {
    const billing = { liveOffers: async () => [CORE] }
    expect(shownOffersOf(billing)).toBe(shownOffersOf(billing))
    expect(shownOffersOf({ liveOffers: async () => [] })).not.toBe(shownOffersOf(billing))
  })
})

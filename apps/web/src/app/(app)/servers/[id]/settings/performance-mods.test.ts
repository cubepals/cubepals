// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Performance section names the performance mods a server runs, the same way whether a copy
 * is Cubepals' or its owner's own, and a server that gets none has no section at all.
 */

import { describe, expect, test } from 'bun:test'
import type { ServerView } from '@blockly/contracts'
import { performanceLine } from './performance-line'
import { PerformanceModsSetting } from './performance-mods'

const does = 'They make it run smoother and ask nothing of your players.'

const BOTH = ['Lithium', 'FerriteCore']

describe('the Performance section', () => {
  test('names the mods the server runs, however many', () => {
    const three = [...BOTH, 'Third']
    expect(performanceLine({ on: true, mods: three, runs: three })).toBe(
      `Cubepals adds Lithium, FerriteCore and Third to this server. ${does}`,
    )
    expect(performanceLine({ on: true, mods: BOTH, runs: BOTH })).toBe(
      `Cubepals adds Lithium and FerriteCore to this server. ${does}`,
    )
    expect(performanceLine({ on: true, mods: ['FerriteCore'], runs: ['FerriteCore'] })).toBe(
      'Cubepals adds FerriteCore to this server. It makes the server run smoother and asks nothing of your players.',
    )
  })

  test('reads the same where the owner runs one or both as their own mods', () => {
    const same = `Cubepals adds Lithium and FerriteCore to this server. ${does}`
    expect(performanceLine({ on: true, mods: [], runs: BOTH })).toBe(same)
    expect(performanceLine({ on: true, mods: ['FerriteCore'], runs: BOTH })).toBe(same)
    expect(performanceLine({ on: true, mods: ['Lithium'], runs: BOTH })).toBe(same)
  })

  test('turned off, says what turning them on would have the server run', () => {
    const three = [...BOTH, 'Third']
    expect(performanceLine({ on: false, mods: three, runs: three })).toBe(
      `Cubepals can add Lithium, FerriteCore and Third to this server. ${does}`,
    )
    for (const mods of [BOTH, ['FerriteCore'], []])
      expect(performanceLine({ on: false, mods, runs: BOTH })).toBe(
        `Cubepals can add Lithium and FerriteCore to this server. ${does}`,
      )
  })

  test('says so where none is out for its Minecraft version, on or off', () => {
    for (const on of [true, false])
      expect(performanceLine({ on, mods: [], runs: [] })).toBe(
        'Cubepals has no performance mods for this server’s Minecraft version yet.',
      )
  })

  test('names what a start places for a control plane from before it said what the server runs', () => {
    expect(performanceLine({ on: true, mods: ['FerriteCore'] })).toBe(
      'Cubepals adds FerriteCore to this server. It makes the server run smoother and asks nothing of your players.',
    )
    expect(performanceLine({ on: false, mods: BOTH })).toBe(
      `Cubepals can add Lithium and FerriteCore to this server. ${does}`,
    )
  })

  test('is not there on a server that gets none, or from a control plane that says nothing of them', () => {
    expect(PerformanceModsSetting({ view: { performanceMods: null } as ServerView })).toBeNull()
    expect(PerformanceModsSetting({ view: {} as ServerView })).toBeNull()
    const on = { on: true, turnedOff: null, mods: ['Lithium'], runs: ['Lithium'] }
    expect(PerformanceModsSetting({ view: { performanceMods: on } as ServerView })).not.toBeNull()
  })
})

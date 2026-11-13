// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Performance section names the mods Cubepals adds as a start places them, and a server that
 * gets none has no section at all.
 */

import { describe, expect, test } from 'bun:test'
import type { ServerView } from '@blockly/contracts'
import { performanceLine } from './performance-line'
import { PerformanceModsSetting } from './performance-mods'

const does = 'They make it run smoother and ask nothing of your players.'

describe('the Performance section', () => {
  test('names the mods a start places, however many', () => {
    expect(performanceLine({ on: true, mods: ['Lithium', 'FerriteCore', 'Third'] })).toBe(
      `Cubepals adds Lithium, FerriteCore and Third to this server. ${does}`,
    )
    expect(performanceLine({ on: true, mods: ['Lithium', 'Third'] })).toBe(
      `Cubepals adds Lithium and Third to this server. ${does}`,
    )
    expect(performanceLine({ on: true, mods: ['FerriteCore'] })).toBe(
      'Cubepals adds FerriteCore to this server. It makes the server run smoother and asks nothing of your players.',
    )
  })

  test('turned off, says what turning them on would bring', () => {
    expect(performanceLine({ on: false, mods: ['Lithium', 'FerriteCore', 'Third'] })).toBe(
      `Cubepals can add Lithium, FerriteCore and Third to this server. ${does}`,
    )
  })

  test('says so where there is nothing to add', () => {
    for (const on of [true, false])
      expect(performanceLine({ on, mods: [] })).toBe(
        'Nothing to add: this server already runs them, or none is out for its Minecraft version yet.',
      )
  })

  test('is not there on a server that gets none, or from a control plane that says nothing of them', () => {
    expect(PerformanceModsSetting({ view: { performanceMods: null } as ServerView })).toBeNull()
    expect(PerformanceModsSetting({ view: {} as ServerView })).toBeNull()
    const on = { on: true, turnedOff: null, mods: ['Lithium'] }
    expect(PerformanceModsSetting({ view: { performanceMods: on } as ServerView })).not.toBeNull()
  })
})

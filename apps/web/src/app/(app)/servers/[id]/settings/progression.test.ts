// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Offline world progression section: there on a server it is for, on or off, and not at all on
 * one it isn't for or from a control plane that says nothing of it; its drawing finds each thing
 * as something else only where the game would.
 */

import { describe, expect, test } from 'bun:test'
import type { ServerView } from '@blockly/contracts'
import { PROGRESSION_DEFAULTS, PROGRESSION_PARTS } from '@blockly/contracts'
import { ProgressionSetting } from './progression'
import { CHANGES, FOUND_AS, PROGRESSION_PARTS_SHOWN } from './progression-line'

describe('the Offline world progression section', () => {
  test('is there on a server it is for, on or off', () => {
    for (const on of [true, false])
      expect(
        ProgressionSetting({ view: { progression: { on, turnedOff: on ? null : 'owner' } } as ServerView }),
      ).not.toBeNull()
  })

  test('is not there on a server it isn’t for, or from a control plane that says nothing of it', () => {
    expect(ProgressionSetting({ view: { progression: null } as ServerView })).toBeNull()
    expect(ProgressionSetting({ view: {} as ServerView })).toBeNull()
  })

  test('has one switch for each part, in their order, and fire alone is off by default', () => {
    expect(PROGRESSION_PARTS_SHOWN.map((shown) => shown.part)).toEqual([...PROGRESSION_PARTS])
    expect(Object.entries(PROGRESSION_DEFAULTS).filter(([, on]) => !on)).toEqual([['fire', false]])
  })

  test('draws what smelting and growing make of each thing, and nothing the game wouldn’t', () => {
    expect(CHANGES.map((c) => [c.id, FOUND_AS[c.id], c.found.count])).toEqual([
      ['raw_iron', 'iron_ingot', 8],
      ['wheat_seeds', 'wheat', 1],
      ['sugar_cane', 'sugar_cane', 3],
    ])
    // Smelting turns one into one, and sugar cane grows to three tall, never more.
    for (const change of CHANGES) expect(change.found.count).toBeLessThanOrEqual(3 * change.left.count)
  })
})

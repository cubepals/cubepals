// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { PLAY_ICONS } from '@blockly/contracts'
import { TEMPLATES } from './templates.ts'

describe('what to play', () => {
  test('every way to play has its own picture', () => {
    // Two rows in one list wearing the same icon reads as a bug, not a choice. The modpack row
    // is not a template, and it takes the bundle — many things carried as one is what a pack is.
    const icons = TEMPLATES.filter((template) => !template.advanced).map((template) => template.icon)
    expect(new Set(icons).size).toBe(icons.length)
    expect(icons).not.toContain('modpack')
    const known: readonly (string | null)[] = PLAY_ICONS
    for (const icon of icons) expect(known).toContain(icon)
    // The server types are tags, a name alone, for the people who came looking for one.
    for (const template of TEMPLATES.filter((template) => template.advanced)) expect(template.icon).toBeNull()
  })

  test('every template has a key of its own, and words in a person’s language', () => {
    const keys = TEMPLATES.map((template) => template.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const template of TEMPLATES) {
      expect(template.title.length).toBeGreaterThan(2)
      expect(template.blurb).toMatch(/\.$/)
      // Nothing on a card names a loader, a build or a version: that is Blockly's business.
      expect(template.blurb.toLowerCase()).not.toContain('loader')
    }
  })
})

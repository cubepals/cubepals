// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { RevisionView } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Summary } from './history'

const revision = (changes: RevisionView['changes']) =>
  ({ reason: 'settings_changed', gameVersion: '26.3', loader: 'paper', changes }) as RevisionView
const drawn = (changes: RevisionView['changes']) =>
  renderToStaticMarkup(createElement(Summary, { revision: revision(changes) }))

describe('a revision in History', () => {
  test('draws a server message in its colours, never as its codes', () => {
    const html = drawn([
      { field: 'difficulty', from: 'easy', to: 'hard' },
      { field: 'motd', from: 'Hello', to: '&d&lcubepals &8· &71.8 PvP' },
    ])
    expect(html).not.toContain('&amp;')
    expect(html).toStartWith('Difficulty Easy → Hard · Server message ')
    expect(html).toContain(
      '<span style="color:#FF55FF;font-weight:700;font-style:normal;text-decoration:none">cubepals </span>',
    )
    expect(html).toContain(
      '<span style="color:#AAAAAA;font-weight:400;font-style:normal;text-decoration:none">1.8 PvP</span>',
    )
    expect(html).toContain('>Hello</span>')
  })

  test('words its other changes as before', () => {
    expect(drawn([{ field: 'pvp', from: true, to: false }])).toBe('PvP on → off')
  })
})

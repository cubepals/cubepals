// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { MOTD_DEFAULT_COLOUR, motdForGame, motdRuns, motdText } from '@blockly/contracts/server-list'

describe('the server list message', () => {
  test('takes & codes as the game takes the section sign, and leaves any other & alone', () => {
    expect(motdForGame('&aGreen &LBold & plain')).toBe('§aGreen §LBold & plain')
    expect(motdForGame('Fish &chips')).toBe('Fish §chips')
    expect(motdForGame('Tom & Jerry &z')).toBe('Tom & Jerry &z')
    expect(motdText('&6Gold §lbold &rplain')).toBe('Gold bold plain')
  })

  test('is drawn stretch by stretch, a colour clearing the styles before it', () => {
    expect(motdRuns('Plain')).toEqual([{ text: 'Plain', colour: MOTD_DEFAULT_COLOUR, styles: [] }])
    expect(motdRuns('&6&lGold &oleaf&r then &cred')).toEqual([
      { text: 'Gold ', colour: '#FFAA00', styles: ['bold'] },
      { text: 'leaf', colour: '#FFAA00', styles: ['bold', 'italic'] },
      { text: ' then ', colour: MOTD_DEFAULT_COLOUR, styles: [] },
      { text: 'red', colour: '#FF5555', styles: [] },
    ])
    expect(motdRuns('&l&abig?')).toEqual([{ text: 'big?', colour: '#55FF55', styles: [] }])
    expect(motdRuns('&a')).toEqual([])
  })
})

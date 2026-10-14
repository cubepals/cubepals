// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { withCode } from './message-codes'
import { messageHints } from './message-hints'

describe('the server message’s hints', () => {
  test('say nothing about a message whose codes do what they look like', () => {
    expect(messageHints('&6&lGold &6coins, Tom & Jerry')).toEqual([])
    expect(messageHints('&d&lcubepals &c&lduels')).toEqual([])
  })

  test('point out an & that isn’t a code', () => {
    expect(messageHints('Fish &zchips')).toEqual(['“&z” isn’t a code, so players see it as typed.'])
  })

  test('point out a style with nothing after it', () => {
    expect(messageHints('Hello &l')).toEqual(['Bold (&l) at the end has nothing to style.'])
    expect(messageHints('&oHi &n&cthere')).toEqual([
      'Underline (&n) ends at the code after it. Put it after the colour.',
      'Red (&c) ends italic. To keep it, write &o after &c.',
    ])
  })

  test('point out a colour that ends a style some words had', () => {
    expect(messageHints('&lBig &cred')).toEqual(['Red (&c) ends bold. To keep it, write &l after &c.'])
    expect(messageHints('&l&oBig &cred')).toEqual([
      'Red (&c) ends bold and italic. To keep it, write &l&o after &c.',
    ])
    // Starting the same colour again is how a style is ended on purpose.
    expect(messageHints('&6&lGold &6coins')).toEqual([])
  })

  test('never come from what the style bar writes', () => {
    const red = withCode('&lHello world', 8, 13, 'c')
    expect(red.motd).toBe('&lHello &c&lworld')
    expect(messageHints(red.motd)).toEqual([])
    const plain = withCode('&6&lGold coins', 9, 14, 'l')
    expect(messageHints(plain.motd)).toEqual([])
  })
})

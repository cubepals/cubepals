// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server message field: the list entry drawn at the game's own places, what the list leaves
 * off, the hints, and the same refusal the control plane gives.
 */
import { describe, expect, test } from 'bun:test'
import type { ServerView } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { messageProblem, ServerMessage } from './server-message'

const view = { name: 'Sunset Valley', icon: null, ownIcon: '/api/public/icons/s/abc.png' } as ServerView
const drawn = (value: string) =>
  renderToStaticMarkup(
    createElement(ServerMessage, { view, value, maxPlayers: 20, problem: null, onChange: () => undefined }),
  )

describe('the server message', () => {
  test('is drawn as the list draws it, beside what was typed', () => {
    const html = drawn('&6Gold &lbold')
    expect(html).toContain('value="&amp;6Gold &amp;lbold"')
    // Each character where the game's widths put it, in its colour, over its shadow.
    expect(html).toContain('<g fill="#FFAA00"><text x="37" y="21" font-style="normal">G</text></g>')
    expect(html).toContain('<g fill="#3f2a00"><text x="38" y="22" font-style="normal">G</text></g>')
    // Bold is the glyph twice, a pixel apart, and a pixel wider: “Gold ” is 6 + 6 + 3 + 6 + 4, so b is at 62, and o 7 on.
    expect(html).toContain(
      '<text x="62" y="21" font-style="normal">b</text><text x="63" y="21" font-style="normal">b</text>',
    )
    expect(html).toContain('<text x="69" y="21" font-style="normal">o</text>')
    expect(html).toContain('<text x="37" y="10" font-style="normal">S</text>')
    expect(html).toContain('href="/api/public/icons/s/abc.png"')
    expect(html).toContain('aria-label="Sunset Valley: Gold bold"')
    // The player count and the signal bars, at the row's right as the game puts them.
    expect(html).toContain('<text x="259" y="10" font-style="normal">0</text>')
    expect(html).toContain('<rect x="296" y="3" width="1" height="6" fill="#00FF21">')
  })

  test('draws what the list leaves off faded and struck through below it', () => {
    expect(drawn('W'.repeat(88))).not.toContain('opacity')
    const html = drawn(`${'W'.repeat(88)}ABCDEF`)
    expect(html).toContain('<g opacity="0.45">')
    expect(html).toContain('viewBox="0 0 305 47"')
  })

  test('can be saved as the control plane takes it, and says why not', () => {
    expect(messageProblem('Come build with us')).toBeNull()
    expect(messageProblem(`  ${'W'.repeat(88)}  `)).toBeNull()
    expect(messageProblem(`${'W'.repeat(88)}ABCDEF`)).toBe(
      'The last 6 characters won’t show in the server list.',
    )
    expect(messageProblem('&6&l ')).toBe('Write something to show under the name.')
  })

  test('has a bar of colours and styles, each named, showing what the caret’s place has', () => {
    const html = drawn('&6Gold')
    expect(html).toContain('<legend class="bk-visually-hidden">Colour and style</legend>')
    expect(html).toContain('aria-label="Gold" title="Gold" aria-pressed="true"')
    expect(html).toContain('aria-label="Bold" title="Bold" aria-pressed="false"')
    expect(html).toContain('aria-label="Reset"')
  })

  test('hints at a code that won’t do what it looks like, only while it is there', () => {
    expect(drawn('&lBig &cred')).toContain('Red (&amp;c) ends bold. To keep it, write &amp;l after &amp;c.')
    expect(drawn('&lBig &c&lred')).not.toContain('ends bold')
  })

  test('plain text stays plain, in the list’s own grey', () => {
    expect(drawn('Hello')).toContain('<g fill="#808080"><text x="37" y="21" font-style="normal">H</text></g>')
  })
})

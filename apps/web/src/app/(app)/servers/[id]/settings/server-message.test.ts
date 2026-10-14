// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { ServerView } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerMessage } from './server-message'

const view = { name: 'Sunset Valley', icon: null, ownIcon: '/api/public/icons/s/abc.png' } as ServerView
const drawn = (value: string) =>
  renderToStaticMarkup(
    createElement(ServerMessage, { view, value, limit: 59, problem: null, onChange: () => undefined }),
  )

describe('the server message', () => {
  test('is drawn as the list draws it, beside what was typed', () => {
    const html = drawn('&6Gold &lbold')
    expect(html).toContain('value="&amp;6Gold &amp;lbold"')
    expect(html).toContain(
      '<span style="color:#FFAA00;font-weight:400;font-style:normal;text-decoration:none">Gold </span>',
    )
    expect(html).toContain(
      '<span style="color:#FFAA00;font-weight:700;font-style:normal;text-decoration:none">bold</span>',
    )
    expect(html).toContain('Sunset Valley')
    expect(html).toContain('src="/api/public/icons/s/abc.png"')
    // Codes take no room in the list, so they don't count against the length.
    expect(html).toContain('50 characters left.')
  })

  test('has a bar of colours and styles, each named, showing what the caret’s place has', () => {
    const html = drawn('&6Gold')
    expect(html).toContain('<legend class="bk-visually-hidden">Colour and style</legend>')
    expect(html).toContain('aria-label="Gold" title="Gold" aria-pressed="true"')
    expect(html).toContain('aria-label="Bold" title="Bold" aria-pressed="false"')
    expect(html).toContain('aria-label="Reset"')
  })

  test('plain text stays plain, in the list’s own grey', () => {
    expect(drawn('Hello')).toContain(
      '<span style="color:#808080;font-weight:400;font-style:normal;text-decoration:none">Hello</span>',
    )
  })
})

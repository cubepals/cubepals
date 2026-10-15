// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { TEMPLATE_CARDS, type TemplateCredits } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MapCredits } from './map-credits'

const line = (credits: TemplateCredits) =>
  renderToStaticMarkup(createElement(MapCredits, { credits }))
    .replace(/<[^>]+>/g, '')
    .trim()

describe('a server page crediting the maps its world is built on', () => {
  test('the Arcade names NetherGames and the Overcast Community, each linked to its published maps', () => {
    const credits = TEMPLATE_CARDS.find((card) => card.key === 'arcade')?.credits
    if (credits === undefined) throw new Error('The Arcade card carries its credits')
    expect(line(credits)).toBe('Built on maps by NetherGames and the Overcast Community.')
    const html = renderToStaticMarkup(createElement(MapCredits, { credits }))
    expect([...html.matchAll(/href="([^"]+)"/g)].map((link) => link[1])).toEqual([
      expect.stringMatching(
        /^https:\/\/github\.com\/NetherGamesMC\/assets\/tree\/[0-9a-f]{40}\/Lobby\/worlds\/ArcadeLobby$/,
      ),
      expect.stringMatching(/^https:\/\/github\.com\/OvercastCommunity\/PublicMaps\/tree\/[0-9a-f]{40}$/),
    ])
    expect(html).toContain('class="type-body-sm"')
  })

  test('one maker, or three, read as a sentence', () => {
    const maker = (name: string) => ({ name, url: `https://example.test/${name}` })
    expect(line({ makers: [maker('Ana')] })).toBe('Built on maps by Ana.')
    expect(line({ makers: [maker('Ana'), maker('Kai'), maker('Lee')] })).toBe(
      'Built on maps by Ana, Kai and Lee.',
    )
  })

  test('only templates with published maps carry a line', () => {
    expect(TEMPLATE_CARDS.filter((card) => 'credits' in card).map((card) => card.key)).toEqual(['arcade'])
  })
})

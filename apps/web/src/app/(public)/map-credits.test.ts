// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The line a server's public page says about the published maps its world is built on: read from
 * the elements `MapCredits` renders, its words and its links, never from markup.
 */
import { describe, expect, test } from 'bun:test'
import { TEMPLATE_CARDS, type TemplateCredits } from '@blockly/contracts'
import { isValidElement, type ReactNode } from 'react'
import { MapCredits } from './map-credits'

interface Node {
  type: unknown
  props: { children?: ReactNode; href?: string; className?: string }
}

/** The line's text and its links, read from the elements it renders, not from markup. */
function read(credits: TemplateCredits) {
  const root = MapCredits({ credits }) as unknown as Node
  const links: Array<{ text: string; href: string | undefined }> = []
  const text = (node: ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    if (!isValidElement(node)) return ''
    const element = node as unknown as Node
    const inside = text(element.props.children)
    if (element.type === 'a') links.push({ text: inside, href: element.props.href })
    return inside
  }
  return { root, text: text(root.props.children), links }
}
const line = (credits: TemplateCredits) => read(credits).text

describe('a server page crediting the maps its world is built on', () => {
  test('the Arcade names NetherGames and the Overcast Community, each linked to its published maps', () => {
    const credits = TEMPLATE_CARDS.find((card) => card.key === 'arcade')?.credits
    if (credits === undefined) throw new Error('The Arcade card carries its credits')
    const { root, text, links } = read(credits)
    expect(text).toBe('Built on maps by NetherGames and the Overcast Community.')
    expect(links).toEqual([
      {
        text: 'NetherGames',
        href: expect.stringMatching(
          /^https:\/\/github\.com\/NetherGamesMC\/assets\/tree\/[0-9a-f]{40}\/Lobby\/worlds\/ArcadeLobby$/,
        ),
      },
      {
        text: 'Overcast Community',
        href: expect.stringMatching(
          /^https:\/\/github\.com\/OvercastCommunity\/PublicMaps\/tree\/[0-9a-f]{40}$/,
        ),
      },
    ])
    expect(root.type).toBe('p')
    expect(root.props.className).toBe('type-body-sm')
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

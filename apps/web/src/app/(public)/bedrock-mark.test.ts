// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "Java and Bedrock" mark on a Browse card and a server's page: only for a server Bedrock
 * players join, never for one with Bedrock off, a modded one or an answer from before it was said.
 */
import { describe, expect, test } from 'bun:test'
import type { ListingCardView, PublicServerView } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiProvider } from '../../lib/api'
import { ViewerProvider } from '../../lib/viewer'
import { Card } from './browse/directory'
import { ServerPage } from './server-page'

const serverId = '6f0b8a52-5f0e-4c3a-9a57-0d1f4c6e2b11'
const MARK = 'Java and Bedrock'

const listing = (
  bedrock: boolean | undefined,
  loader: ListingCardView['loader'] = 'vanilla',
): ListingCardView => ({
  serverId,
  slug: 'copper-cove',
  name: 'Copper Cove',
  description: 'A quiet survival world.',
  icon: null,
  ownIcon: null,
  tags: ['survival'],
  joinAddress: 'copper-cove.play.blockly.test',
  online: 0,
  awake: false,
  lastPlayedAt: null,
  whitelistOnly: false,
  gameVersion: '26.2',
  loader,
  mods: [],
  ...(bedrock === undefined ? {} : { bedrock }),
  official: false,
  reactions: { serverId, stars: 0, starred: false, notes: 0, yours: false },
})

const page = (
  bedrock: boolean | undefined,
  loader: PublicServerView['loader'] = 'vanilla',
): PublicServerView => ({
  slug: 'copper-cove',
  name: 'Copper Cove',
  description: '',
  credits: null,
  icon: null,
  ownIcon: null,
  tags: [],
  joinAddress: 'copper-cove.play.blockly.test',
  awake: false,
  wakesSlowly: false,
  online: 0,
  maxPlayers: 10,
  players: [],
  checksAccounts: true,
  gameVersion: '26.2',
  loader,
  needs: {
    gameVersion: '26.2',
    joins: { oldest: '1.9', newer: true },
    modpack: null,
    loader: null,
    mods: [],
  },
  ...(bedrock === undefined ? {} : { bedrock }),
  mods: [],
  whitelistOnly: false,
  invited: false,
  public: true,
  preview: false,
  official: false,
  copyable: false,
  yours: false,
  chipIn: null,
  reactions: null,
})

const rendered = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(
      ApiProvider,
      null,
      // biome-ignore lint/correctness/noChildrenProp: with no JSX in a test, its props are where the provider's children are typed
      createElement(ViewerProvider, { signedIn: false, children: element }),
    ),
  )

describe('the Java and Bedrock mark', () => {
  test('a Browse card wears it only for a server Bedrock players join', () => {
    expect(rendered(createElement(Card, { listing: listing(true) }))).toContain(MARK)
    expect(rendered(createElement(Card, { listing: listing(false) }))).not.toContain(MARK)
    expect(rendered(createElement(Card, { listing: listing(false, 'fabric') }))).not.toContain(MARK)
    expect(rendered(createElement(Card, { listing: listing(undefined) }))).not.toContain(MARK)
  })

  test('a server’s page wears it, and tells phones and tablets how to join, only where they can', () => {
    const takes = rendered(createElement(ServerPage, { view: page(true) }))
    expect(takes).toContain(MARK)
    expect(takes).toContain('On a phone or tablet')
    expect(takes).not.toContain('Consoles and phones can’t join.')
    for (const view of [page(false), page(false, 'fabric'), page(undefined)]) {
      const html = rendered(createElement(ServerPage, { view }))
      expect(html).not.toContain(MARK)
      expect(html).toContain('Consoles and phones can’t join.')
    }
  })
})

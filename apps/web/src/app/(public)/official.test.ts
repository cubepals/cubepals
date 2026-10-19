// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The seal on a Browse card and a server's page: after the name, and only for a server marked
 * official.
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
const SEAL = 'aria-label="Official: run by Cubepals"'

const listing = (official: boolean): ListingCardView => ({
  serverId,
  slug: 'arcade',
  name: 'Arcade',
  description: 'Games to play together.',
  icon: null,
  ownIcon: null,
  tags: ['minigames'],
  joinAddress: 'arcade.play.blockly.test',
  online: 3,
  awake: true,
  lastPlayedAt: null,
  whitelistOnly: false,
  gameVersion: '1.21.4',
  loader: 'vanilla',
  mods: [],
  official,
  reactions: { serverId, stars: 0, starred: false, notes: 0, yours: false },
})

const page = (official: boolean): PublicServerView => ({
  slug: 'arcade',
  name: 'Arcade',
  description: '',
  credits: null,
  icon: null,
  ownIcon: null,
  tags: ['minigames'],
  joinAddress: 'arcade.play.blockly.test',
  awake: true,
  wakesSlowly: false,
  online: 0,
  maxPlayers: 10,
  players: [],
  checksAccounts: true,
  gameVersion: '1.21.4',
  loader: 'vanilla',
  needs: {
    gameVersion: '1.21.4',
    joins: { oldest: '1.21.4', newer: false },
    modpack: null,
    loader: null,
    mods: [],
  },
  mods: [],
  whitelistOnly: false,
  invited: false,
  public: true,
  preview: false,
  official,
  copyable: false,
  yours: false,
  chipIn: null,
  reactions: { serverId, stars: 0, starred: false, notes: 0, yours: false },
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

describe('the seal beside an official server’s name', () => {
  test('a Browse card shows it after the name only for an official server, and no chip', () => {
    const official = rendered(createElement(Card, { listing: listing(true) }))
    expect(official).toContain(SEAL)
    expect(official.indexOf(SEAL)).toBeGreaterThan(official.indexOf('>Arcade</a>'))
    expect(official).not.toContain('Run by Cubepals')
    expect(rendered(createElement(Card, { listing: listing(false) }))).not.toContain(SEAL)
  })

  test('a server’s page shows it in the heading only for an official server', () => {
    const official = rendered(createElement(ServerPage, { view: page(true) }))
    expect(official).toMatch(/<h1[^>]*>Arcade⁠<span[^>]*><svg[^>]*aria-label="Official: run by Cubepals"/)
    expect(official).not.toContain('Run by Cubepals<')
    expect(rendered(createElement(ServerPage, { view: page(false) }))).not.toContain(SEAL)
  })
})

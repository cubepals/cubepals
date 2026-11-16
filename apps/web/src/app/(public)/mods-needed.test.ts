// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a server's page tells a player to have in their game before joining: each mod at the
 * version the server runs, linked to that version, the server's other mods for a game that carries
 * them anyway, and what to do in each launcher.
 */
import { describe, expect, test } from 'bun:test'
import type { JoinNeeds, PublicServerView } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiProvider } from '../../lib/api'
import { ViewerProvider } from '../../lib/viewer'
import { ServerPage } from './server-page'

const page = (needs: Partial<JoinNeeds>): PublicServerView => ({
  slug: 'cog-valley',
  name: 'Cog Valley',
  description: '',
  credits: null,
  icon: null,
  ownIcon: null,
  tags: [],
  joinAddress: 'cog-valley.play.blockly.test',
  awake: false,
  wakesSlowly: false,
  online: 0,
  maxPlayers: 10,
  players: [],
  checksAccounts: true,
  gameVersion: '26.3',
  loader: 'fabric',
  needs: {
    gameVersion: '26.3',
    joins: { oldest: '26.3', newer: false },
    modpack: null,
    loader: null,
    mods: [],
    ifCarried: [],
    ...needs,
  },
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

const rendered = (view: PublicServerView) =>
  renderToStaticMarkup(
    createElement(
      ApiProvider,
      null,
      // biome-ignore lint/correctness/noChildrenProp: with no JSX in a test, its props are where the provider's children are typed
      createElement(ViewerProvider, { signedIn: false, children: createElement(ServerPage, { view }) }),
    ),
  )

const create = {
  name: 'Create',
  version: '6.0.4',
  url: 'https://modrinth.com/project/LNytGWDc/version/aB3dE9fG',
}
const veinMiner = {
  name: 'VeinMiner',
  version: '2.14.0',
  url: 'https://modrinth.com/project/OhduvhIc/version/k9Lm2NpQ',
}
const LAUNCHERS = ['Modrinth App or CurseForge:', 'Prism Launcher:', 'Minecraft Launcher:']

describe('the mods a server’s page asks for', () => {
  test('each at the version the server runs, linked to that version, with what to do in each launcher', () => {
    const html = rendered(
      page({ loader: { label: 'Fabric', version: '0.19.2' }, mods: [create], ifCarried: [veinMiner] }),
    )
    expect(html).toContain('What you need first')
    expect(html).toContain(`href="${create.url}"`)
    expect(html).toContain('Create 6.0.4')
    for (const launcher of LAUNCHERS) expect(html).toContain(launcher)
    // The server's other mods, for a game that carries them anyway.
    expect(html).toContain('Have its other mods in your game too?')
    expect(html).toContain(`href="${veinMiner.url}"`)
    expect(html).toContain('VeinMiner 2.14.0')
  })

  test('plain Minecraft joins, and a game that has one of its mods still finds the version to match', () => {
    const html = rendered(page({ ifCarried: [veinMiner] }))
    expect(html).toContain('Nothing to install')
    expect(html).not.toContain('What you need first')
    expect(html).toContain('Have any of its mods in your game?')
    expect(html).toContain('VeinMiner 2.14.0')
    for (const launcher of LAUNCHERS) expect(html).toContain(launcher)
  })

  test('nothing to carry says only that plain Minecraft joins', () => {
    const html = rendered(page({}))
    expect(html).toContain('Nothing to install')
    expect(html).not.toContain('in your game')
    for (const launcher of LAUNCHERS) expect(html).not.toContain(launcher)
  })

  test('a jar its owner uploaded is named with its version, and is never linked', () => {
    const own = { name: 'Our tweaks', version: '1.0', url: null }
    const html = rendered(page({ loader: { label: 'Fabric', version: null }, mods: [own] }))
    expect(html).toContain('Our tweaks 1.0 — ask the owner for it')
  })

  test('an answer from before versions names each mod as it did', () => {
    const before = { ...page({ loader: { label: 'Fabric', version: null } }) }
    const { ifCarried: _, ...needs } = before.needs
    const html = rendered({
      ...before,
      needs: { ...needs, mods: [{ name: 'Create', url: 'https://modrinth.com/project/LNytGWDc' }] },
    })
    expect(html).toContain('href="https://modrinth.com/project/LNytGWDc"')
    expect(html).not.toContain('undefined')
  })
})

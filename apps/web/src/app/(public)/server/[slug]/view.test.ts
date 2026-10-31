// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's own page by its slug, as the browser draws it from the page and resting answers: the
 * page the game sends everyone it turns away from a server resting for its owner's free trial.
 */
import { describe, expect, test } from 'bun:test'
import type { OpenedPage, PublicServerView as Page, RestingView } from '@blockly/contracts'
import type { AppRouter } from '@blockly/control/router'
import { dehydrate, QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import { PathParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiProvider } from '../../../../lib/api'
import { ViewerProvider } from '../../../../lib/viewer'
import { PublicServerView } from './view'

const slug = 'sunset-valley'
const serverId = '6f0b8a52-5f0e-4c3a-9a57-0d1f4c6e2b11'

const page: Page = {
  slug,
  name: 'Sunset Valley',
  description: '',
  credits: null,
  icon: null,
  ownIcon: null,
  tags: [],
  joinAddress: 'sunset-valley.play.blockly.test',
  awake: false,
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
  official: false,
  copyable: false,
  yours: false,
  chipIn: null,
  reactions: { serverId, stars: 0, starred: false, notes: 0, yours: false },
}
const resting: RestingView = { name: 'Sunset Valley', yours: false }

/** The page as drawn with what the control plane answered for it, or before it answered. */
function drawn(answer?: OpenedPage | null): string {
  const queryClient = new QueryClient()
  const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: 'http://localhost/api/trpc' })] })
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient })
  if (answer !== undefined) queryClient.setQueryData(trpc.sharing.page.queryKey({ slug }), answer)
  const view = createElement(PathParamsContext.Provider, { value: { slug } }, createElement(PublicServerView))
  return renderToStaticMarkup(
    createElement(ApiProvider, {
      data: dehydrate(queryClient),
      // biome-ignore lint/correctness/noChildrenProp: with no JSX in a test, its props are where the provider's children are typed
      children: createElement(ViewerProvider, { signedIn: false, children: view }),
    }),
  )
}

describe('a server’s page by its slug', () => {
  test('a private server resting for its free trial says only that it rests', () => {
    const html = drawn({ kind: 'resting', resting })
    expect(html).toContain('Sunset Valley is resting')
    expect(html).not.toContain('This server is private')
    expect(html).not.toContain('sunset-valley.play.blockly.test')
  })

  test('a private server that isn’t resting is private, as before', () => {
    const html = drawn(null)
    expect(html).toContain('This server is private')
    expect(html).not.toContain('is resting')
  })

  test('a public server resting says so above its page', () => {
    const html = drawn({ ...page, resting })
    expect(html.indexOf('Sunset Valley is resting')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('Sunset Valley is resting')).toBeLessThan(
      html.indexOf('sunset-valley.play.blockly.test'),
    )
  })

  test('a public server playing as usual is its page alone', () => {
    const html = drawn(page)
    expect(html).toContain('sunset-valley.play.blockly.test')
    expect(html).not.toContain('is resting')
  })

  test('says it is loading until the page answers', () => {
    const html = drawn()
    expect(html).toContain('bk-skeleton')
    expect(html).not.toContain('This server is private')
  })
})

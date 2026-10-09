import { describe, expect, test } from 'bun:test'
import type { PublicServerView } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiProvider } from '../../lib/api'
import { ViewerProvider } from '../../lib/viewer'
import { reportable, reportReason } from './report'
import { RunsOnBlockly } from './server-page'

const serverId = '6f0b8a52-5f0e-4c3a-9a57-0d1f4c6e2b11'

/** A server's public page as a stranger reads it. */
const page = (change: Partial<PublicServerView> = {}): PublicServerView => ({
  slug: 'sunset',
  name: 'Sunset Valley',
  description: '',
  icon: null,
  tags: [],
  joinAddress: 'sunset.play.blockly.test',
  awake: true,
  wakesSlowly: false,
  online: 0,
  maxPlayers: 10,
  players: [],
  checksAccounts: true,
  gameVersion: '1.21.4',
  loader: 'vanilla',
  needs: { gameVersion: '1.21.4', modpack: null, loader: null, mods: [] },
  mods: [],
  whitelistOnly: false,
  invited: false,
  public: true,
  preview: false,
  copyable: false,
  yours: false,
  reactions: { serverId, stars: 0, starred: false, notes: 0, yours: false },
  ...change,
})

const foot = (view: PublicServerView, signedIn: boolean) =>
  renderToStaticMarkup(
    createElement(
      ApiProvider,
      null,
      // biome-ignore lint/correctness/noChildrenProp: with no JSX in a test, its props are where the provider's children are typed
      createElement(ViewerProvider, { signedIn, children: createElement(RunsOnBlockly, { view }) }),
    ),
  )

describe('reporting a server from its page', () => {
  test('someone signed in can report a public page that isn’t theirs, and nobody else is offered it', () => {
    expect(reportable(page(), true)).toBe(serverId)
    expect(foot(page(), true)).toContain('>Report</button>')
    // Signed out, the owner's own page, and an invitation, which is its owner's link to friends.
    expect(reportable(page(), false)).toBeNull()
    expect(reportable(page({ yours: true }), true)).toBeNull()
    expect(reportable(page({ invited: true, public: false, reactions: null }), true)).toBeNull()
    expect(foot(page(), false)).not.toContain('Report')
    expect(foot(page({ yours: true }), true)).not.toContain('Report')
  })

  test('a reason says enough for an admin to look, within what the API takes', () => {
    // Nothing typed yet is not a mistake; the button waits for it.
    expect(reportReason('')).toBeNull()
    expect(reportReason('  ab  ')).toContain('Say a little more')
    expect(reportReason('abc')).toBeNull()
    // `listings.report` takes 3 to 500 characters once trimmed.
    expect(reportReason(`${'x'.repeat(500)}  `)).toBeNull()
    expect(reportReason('x'.repeat(501))).toContain('up to 500')
  })
})

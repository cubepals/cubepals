// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The frame of the pages anyone can read: the directory, pricing, the guides and the policies.
 * Signed in or not, the header says where to go next, and the footer leads on to the guides.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { SiteFooter } from '../../legal/footer'
import { ApiProvider } from '../../lib/api'
import { currentSession } from '../../lib/session'
import { ViewerProvider } from '../../lib/viewer'
import { Button } from '../../ui'
import { WithBeta } from '../../ui/beta'
import { guidesIndexLive } from './guides'
import { GuideLinks } from './guides/links'
import { Presses } from './presses'
import { ctaMark } from './steps'

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const session = await currentSession()
  return (
    <div className="bk-page" style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header className="bk-topnav">
        <WithBeta>
          <Link href="/" className="bk-wordmark">
            Cubepals
          </Link>
        </WithBeta>
        <nav className="bk-topnav__links" aria-label="Cubepals">
          <Link href="/browse" className="bk-topnav__link" {...ctaMark('header_browse')}>
            Browse servers
          </Link>
          <Link href="/pricing" className="bk-topnav__link" {...ctaMark('header_pricing')}>
            Pricing
          </Link>
          {guidesIndexLive() && (
            <Link
              href="/guides"
              className="bk-topnav__link bk-topnav__link--wide"
              {...ctaMark('header_guides')}
            >
              Guides
            </Link>
          )}
        </nav>
        <div className="bk-topnav__actions">
          {session ? (
            <Button variant="outline" href="/servers">
              Your servers
            </Button>
          ) : (
            <Button variant="outline" href="/sign-in" {...ctaMark('header_sign_in')}>
              Sign in
            </Button>
          )}
        </div>
      </header>
      <main className="bk-stack" style={{ flex: 1, gap: 'var(--space-24)', paddingBlock: 'var(--space-32)' }}>
        <ApiProvider>
          <ViewerProvider signedIn={session !== null}>{children}</ViewerProvider>
        </ApiProvider>
      </main>
      <Presses />
      <SiteFooter>
        <GuideLinks index />
      </SiteFooter>
    </div>
  )
}

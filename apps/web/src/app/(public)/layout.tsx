// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The frame of the pages anyone can read: the directory, pricing, the guides and the policies.
 * Signed in or not, the header says where to go next (header.tsx, the landing page's too), and the
 * footer leads on to the guides.
 */
import type { ReactNode } from 'react'
import { SiteFooter } from '../../legal/footer'
import { ApiProvider } from '../../lib/api'
import { currentSession } from '../../lib/session'
import { ViewerProvider } from '../../lib/viewer'
import { GuideLinks } from './guides/links'
import { SiteHeader } from './header'
import { Presses } from './presses'

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const session = await currentSession()
  return (
    <div className="bk-page" style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader signedIn={session !== null} />
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

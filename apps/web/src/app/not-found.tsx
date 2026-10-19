// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from 'next'
import Link from 'next/link'
import { currentSession } from '../lib/session'
import { Lost } from '../ui/lost'
import { SiteHeader } from './(public)/header'

export const metadata: Metadata = { title: 'Page not found' }

/**
 * Every address the site doesn't have, and every `notFound()`: a Cubepals page with the 404 status
 * Next gives it, in place of the default. The root layout frames it, under the same header as the
 * public pages (beta tag, Browse, Pricing, Sign in).
 */
export default async function NotFound() {
  const session = await currentSession()
  return (
    <div className="bk-page">
      <SiteHeader signedIn={session !== null} />
      <main>
        <Lost kind="notFound">
          <Link href="/browse" className="bk-btn bk-btn--outline bk-btn--md">
            Browse servers
          </Link>
          <Link href="/servers" className="bk-btn bk-btn--outline bk-btn--md">
            Your servers
          </Link>
        </Lost>
      </main>
    </div>
  )
}

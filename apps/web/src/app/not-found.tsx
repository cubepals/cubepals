// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import Link from 'next/link'
import { Lockup } from '../ui/brand'
import { Lost } from '../ui/lost'

/**
 * Every address the site doesn't have, and every `notFound()`: a Cubepals page with the 404 status
 * Next gives it, in place of the default. The root layout frames it, with no header of the site's.
 */
export default function NotFound() {
  return (
    <div className="bk-page">
      <header className="bk-topnav">
        <Link href="/" className="bk-wordmark" aria-label="Cubepals">
          <Lockup />
        </Link>
      </header>
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

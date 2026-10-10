// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { SiteFooter } from '../../legal/footer'
import { UNLISTED } from '../../lib/site'
import { Lockup } from '../../ui/brand'
import styles from './auth.module.css'

/** Signing in, up and back in is nothing to land on from a search. */
export const metadata: Metadata = { robots: UNLISTED }

/**
 * The form on canvas, and beside it the landing page's own picture in its own block: the chunk
 * under its night sky, asleep, printed as the landing prints it. A picture never sits behind
 * text, so it stays whole and the form stays plain to read. Below 1024px the form has the
 * screen to itself.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bk-page">
      <header className="bk-topnav">
        <Link href="/" className="bk-wordmark" aria-label="Cubepals">
          <Lockup />
        </Link>
      </header>
      <main className={styles.split}>
        <div className={styles.column}>{children}</div>
        <div className={`bk-imageblock ${styles.art}`}>
          <Image src="/imagery/chunk-asleep.png" alt="" fill sizes="(min-width: 1024px) 50vw, 1px" />
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import Link from 'next/link'
import { ctaMark } from '../../app/(public)/steps'
import { WithBeta } from '../../ui/beta'
import { Lockup } from '../../ui/brand'
import styles from './film.module.css'

/** The page's own header: the name, and the ways to the prices and to signing in. */
export function Nav({ signedIn }: { signedIn: boolean }) {
  return (
    <header className={styles.nav}>
      <WithBeta>
        <Link href="/" className={styles.wordmark} aria-label="Cubepals">
          <Lockup />
        </Link>
      </WithBeta>
      <nav className={styles.links} aria-label="Cubepals">
        <Link href="/pricing" className={styles.link} {...ctaMark('nav_pricing')}>
          Pricing
        </Link>
        <Link
          href={signedIn ? '/servers' : '/sign-in'}
          className={styles.link}
          {...(signedIn ? {} : ctaMark('nav_sign_in'))}
        >
          {signedIn ? 'Your servers' : 'Sign in'}
        </Link>
      </nav>
    </header>
  )
}

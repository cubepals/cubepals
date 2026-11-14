// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one header of the pages anyone can read: the landing page and every public page. The
 * lockup, Browse, Pricing, Sign in (or Your servers), and "Create a server" once the page has been
 * scrolled. On the landing it stays at the top of the screen, on the ground of the section under it.
 */
import Link from 'next/link'
import { WithBeta } from '../../ui/beta'
import { Lockup } from '../../ui/brand'
import styles from './header.module.css'
import { HeaderCreate } from './header-create'
import { ctaMark } from './steps'

export function SiteHeader({
  signedIn,
  create = '/servers/new',
  marks = 'header',
  over = false,
}: {
  signedIn: boolean
  /** Where "Create a server" leads. */
  create?: string
  /** What its presses are counted as: the landing's own names, or the public pages'. */
  marks?: 'header' | 'nav'
  /** Set on the landing: it stays at the top of the screen, on the ground of the section under it. */
  over?: boolean
}) {
  return (
    <header className={styles.header} data-over-picture={over || undefined}>
      <WithBeta>
        <Link href="/" className={styles.lockup} aria-label="Cubepals">
          <Lockup />
        </Link>
      </WithBeta>
      <nav className={styles.links} aria-label="Cubepals">
        <Link href="/browse" className={styles.link} {...ctaMark(`${marks}_browse`)}>
          Browse
        </Link>
        <Link href="/pricing" className={styles.link} {...ctaMark(`${marks}_pricing`)}>
          Pricing
        </Link>
        <Link
          href={signedIn ? '/servers' : '/sign-in'}
          className={styles.link}
          {...(signedIn ? {} : ctaMark(`${marks}_sign_in`))}
        >
          {signedIn ? 'Your servers' : 'Sign in'}
        </Link>
        <HeaderCreate href={create} className={styles.create} />
      </nav>
    </header>
  )
}

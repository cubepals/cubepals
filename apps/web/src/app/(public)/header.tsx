// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one header of the pages anyone can read: the landing page (its film and the phone's page)
 * and every public page. The lockup, Browse, Pricing, Sign in (or Your servers), and "Create a
 * server" once the page has been scrolled. Over the landing's picture it is fixed and has no
 * ground of its own: the picture keeps quiet behind it (`data-quiet`, Chunk.tsx).
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
  /** Set over the landing's picture: fixed to the top of the screen, with no ground of its own. */
  over?: boolean
}) {
  return (
    <header className={styles.header} data-over-picture={over || undefined} data-quiet={over || undefined}>
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

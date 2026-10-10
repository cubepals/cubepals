// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import Link from 'next/link'
import { footerGuides } from '../../app/(public)/guides'
import { GuideLinks } from '../../app/(public)/guides/links'
import { MOJANG_DISCLAIMER, OperatorLine, PolicyLinks } from '../../legal/footer'
import { Lockup, SOURCE_URL } from '../../ui/brand'
import styles from './surface.module.css'

/**
 * The foot of the page, with room: the name, its links in groups (the product and its code, the
 * first how-to guides, every policy), who runs it and Mojang's own words, and the name once more,
 * drawn in outline across the whole width and fading into the page's end.
 */
export function Footer() {
  return (
    <footer className={`bl-section ${styles.footer}`} data-tone="paper">
      <div className={styles.footerTop}>
        <Lockup className={styles.mark} />
        <nav className={styles.footerGroups} aria-label="More">
          <div className={styles.footerGroup}>
            <p className={styles.groupName}>Cubepals</p>
            <Link href="/pricing">Pricing</Link>
            <Link href="/browse">Browse servers</Link>
            <a href={SOURCE_URL}>Source code</a>
          </div>
          {footerGuides().length > 0 && (
            <div className={styles.footerGroup}>
              <p className={styles.groupName}>Guides</p>
              <GuideLinks />
            </div>
          )}
          <div className={styles.footerGroup}>
            <p className={styles.groupName}>Policies</p>
            <PolicyLinks />
          </div>
        </nav>
      </div>
      <div className={styles.footerFine}>
        <p className={styles.legal}>
          <OperatorLine />
        </p>
        {/* Mojang's own words, as its usage guidelines ask of anything built around the game. */}
        <p className={styles.legal}>{MOJANG_DISCLAIMER}</p>
      </div>
      <div className={styles.footerName} aria-hidden>
        <Lockup />
      </div>
    </footer>
  )
}

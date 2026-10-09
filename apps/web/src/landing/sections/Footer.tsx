import Link from 'next/link'
import { GuideLinks } from '../../app/(public)/guides/links'
import { MOJANG_DISCLAIMER, OperatorLine, PolicyLinks } from '../../legal/footer'
import { Lockup } from '../../ui/brand'
import styles from './surface.module.css'

/**
 * The foot of the page: the name, its links, the first how-to guides and every policy, who runs it,
 * and Mojang's own words.
 */
export function Footer() {
  return (
    <footer className={`bl-section ${styles.footer}`} data-tone="paper">
      <Lockup className={styles.mark} />
      <nav className={styles.footerLinks} aria-label="More">
        <Link href="/pricing">Pricing</Link>
        <Link href="/browse">Browse servers</Link>
        <GuideLinks />
        <PolicyLinks />
      </nav>
      <p className={styles.legal}>
        <OperatorLine />
      </p>
      {/* Mojang's own words, as its usage guidelines ask of anything built around the game. */}
      <p className={styles.legal}>{MOJANG_DISCLAIMER}</p>
    </footer>
  )
}

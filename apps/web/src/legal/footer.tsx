/**
 * The foot of the pages: who runs the service, every policy, and Mojang's words. The landing page
 * builds its own from the same parts.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { SOURCE_URL } from '../ui/brand'
import styles from './footer.module.css'
import { hrefOf, POLICIES } from './policies'
import { Sentence } from './prose'

/** Mojang's own words, as its usage guidelines ask of anything built around the game. */
export const MOJANG_DISCLAIMER =
  'NOT AN OFFICIAL MINECRAFT SERVICE. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.'

/** Who runs the service and how to reach them, in one line. */
export function OperatorLine() {
  return <Sentence text="{brand} is run by {name}, {country}. Contact: {support}" />
}

/** A link to every policy, and to the page that lists them. */
export function PolicyLinks() {
  return (
    <>
      {POLICIES.map((policy) => (
        <Link key={policy.slug} href={hrefOf(policy)}>
          {policy.title}
        </Link>
      ))}
    </>
  )
}

/**
 * The foot of every page outside the landing page (which has its own, from the same parts): who
 * runs the service, every policy, and Mojang's words. A layout may put its own links first, as the
 * public pages do with the guides.
 */
export function SiteFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className={styles.footer}>
      {children && (
        <nav className={styles.links} aria-label="Guides">
          {children}
        </nav>
      )}
      <nav className={styles.links} aria-label="Legal">
        <PolicyLinks />
      </nav>
      <p className={styles.operator}>
        <OperatorLine /> · <a href={SOURCE_URL}>Source code</a>
      </p>
      <p className={styles.disclaimer}>{MOJANG_DISCLAIMER}</p>
    </footer>
  )
}

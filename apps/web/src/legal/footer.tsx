// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The foot of the pages: who runs the service, every policy, Mojang's words and a small joke. The
 * landing page builds its own from the same parts.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { SOURCE_URL } from '../ui/brand'
import { OutLink } from '../ui/out-link'
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
 * A wink at the badge funded startups wear: Cubepals pays its own way. Text, not a link; a footer
 * may add its own class for its small type.
 */
export function NotBacked({ className }: { className?: string }) {
  return (
    <p className={className ? `${styles.notBacked} ${className}` : styles.notBacked}>
      <span className={styles.badge}>
        Not backed by
        {/* From https://www.ycombinator.com/ (its own logo, as the site serves it). */}
        {/* biome-ignore lint/performance/noImgElement: a fixed-size mark, too small to need Next's image pipeline */}
        <img src="/y-combinator.svg" alt="" width={14} height={14} draggable={false} />Y Combinator
      </span>{' '}
      · Proudly backed by my salary and my family’s patience
    </p>
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
        <OperatorLine /> · <OutLink href={SOURCE_URL}>Source code</OutLink>
      </p>
      <p className={styles.disclaimer}>{MOJANG_DISCLAIMER}</p>
      <NotBacked />
    </footer>
  )
}

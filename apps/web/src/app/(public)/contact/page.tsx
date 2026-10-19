// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How to reach Cubepals: one address, what helps us help, and where else to look first. The
 * address is the operator's (legal/operator.ts), the one the beta letter and the policies give.
 * There is no status page to link, so "is it just you" points at the places that show what a
 * player's own servers are doing. /contact-us is sent here (next.config.ts), and the footers and
 * the error pages link it.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { OPERATOR } from '../../../legal/operator'
import { pageMetadata } from '../../../lib/site'
import { SOURCE_URL } from '../../../ui/brand'
import { OutLink } from '../../../ui/out-link'
import styles from './contact.module.css'

export const metadata: Metadata = pageMetadata({
  title: 'Contact us',
  description: 'Write to Cubepals. What helps us help, and where to look first if a server isn’t starting.',
  path: '/contact',
})

export default function Contact() {
  const { support, privacy } = OPERATOR.emails
  return (
    <article className={styles.contact}>
      <h1 className="type-display-md">Contact us</h1>
      <p>
        Write to <a href={`mailto:${support}`}>{support}</a>. We read every message.
      </p>
      <p>It helps to tell us your server’s name or address, what you were doing, and what you saw.</p>
      <h2 className="type-heading-sm">Before you write</h2>
      <ul>
        <li>
          <Link href="/servers">Your servers</Link> shows whether each one is awake or asleep. A server that
          is asleep wakes when someone joins.
        </li>
        <li>
          The <Link href="/guides">guides</Link> cover joining, whitelists and mods.
        </li>
      </ul>
      <h2 className="type-heading-sm">Something else</h2>
      <ul>
        <li>
          A question about your data: <a href={`mailto:${privacy}`}>{privacy}</a>.
        </li>
        <li>
          A bug in the code, or an idea:{' '}
          <OutLink href={`${SOURCE_URL}/issues/new/choose`}>open an issue</OutLink>.
        </li>
        <li>
          A security problem: report it privately, as{' '}
          <OutLink href={`${SOURCE_URL}/security/policy`}>our policy</OutLink> says.
        </li>
      </ul>
    </article>
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The beta letter: a short note, set as a letter rather than a page of features, on what being
 * early means. Each line holds only what the code does today: a full platform refuses new servers
 * and not the ones people have (domain/policy/policy.ts), and a world is copied each time it sleeps
 * after play and each day it plays on (operations/handlers/winding-down.ts,
 * operations/schedules/scheduled-backups.ts). The tag and the banner lead here (ui/beta.tsx), and
 * opening it puts the banner away; the page stays when the beta switch is off.
 */
import type { Metadata } from 'next'
import { OPERATOR } from '../../../legal/operator'
import { pageMetadata } from '../../../lib/site'
import { Lockup } from '../../../ui/brand'
import styles from './letter.module.css'
import { Read } from './read'

export const metadata: Metadata = pageMetadata({
  title: 'Cubepals is in beta',
  description:
    'A short letter from Cubepals: it is new and opening a little at a time. What that means for your servers and worlds, and how to reach us.',
  path: '/beta',
})

export default function BetaLetter() {
  const support = OPERATOR.emails.support
  return (
    <article className={styles.letter}>
      <Read />
      <h1 className={`type-display-md ${styles.title}`}>Cubepals is in beta</h1>
      <p>Thanks for being here early.</p>
      <p>
        Cubepals is new, and we’re opening the doors a little at a time. Most days you won’t notice. Some days
        you might:
      </p>
      <ul className={styles.list}>
        <li>
          When we’re full, we say so, and you can make your server a little later. Servers you already have
          still start and wake.
        </li>
        <li>Some things will break. When they do, we fix them and tell you what happened.</li>
        <li>Your worlds are kept safe. We save a copy of each one every day it’s played.</li>
      </ul>
      <p>
        If something feels off, write to us at <a href={`mailto:${support}`}>{support}</a>. We read every
        message.
      </p>
      <p className={styles.signed}>
        <Lockup />
      </p>
    </article>
  )
}

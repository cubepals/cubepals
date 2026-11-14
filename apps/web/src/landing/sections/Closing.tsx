// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The last thing on the page before its foot: the button once more, with the free trial and what
 * the paid plan comes to for a group under it, beside the island asleep. Ink, as the first screen
 * was: the page ends where it began, at night, with a world waiting for its friends.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import { ctaMark, seenMark } from '../../app/(public)/steps'
import { Print } from '../island/Print'
import { Snore } from '../island/Snore'
import { STILL_MARKS } from '../island/stills'
import styles from './closing.module.css'
import { lastSaid } from './said'

export function Closing({ create, plans }: { create: string; plans: readonly PublicPlan[] }) {
  return (
    <section
      className={styles.closing}
      data-tone="ink"
      data-closing
      aria-labelledby="closing"
      {...seenMark('closing')}
    >
      <div className="lp-sheet">
        <div className={`lp-pad ${styles.inner}`}>
          <h2 id="closing" className={`lp-display lp-arrive ${styles.title}`}>
            Start a world with your friends.
          </h2>
          <div className={styles.go}>
            <Link href={create} className="bk-btn bk-btn--lg bk-btn--inverse" {...ctaMark('last_create')}>
              Create a server
            </Link>
            <p className={styles.small}>{lastSaid(plans)}</p>
          </div>
          <div className={styles.picture} aria-hidden>
            <Print which="leave">{STILL_MARKS.chimney && <Snore at={STILL_MARKS.chimney} />}</Print>
          </div>
        </div>
      </div>
    </section>
  )
}

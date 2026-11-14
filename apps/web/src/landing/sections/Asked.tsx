// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The questions people ask before they start, answered as the pricing page answers them: the same
 * questions, in the same words, from the same plan table (pricing/questions.tsx), so the two pages
 * can never disagree. Set on the sheet with a way to ask anything else.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import { Questions } from '../../app/(public)/pricing/questions'
import { seenMark } from '../../app/(public)/steps'
import styles from './asked.module.css'

export function Asked({ plans }: { plans: readonly PublicPlan[] }) {
  return (
    <section className={styles.asked} data-tone="paper" {...seenMark('questions')}>
      <div className="lp-sheet">
        <div className={`lp-pad ${styles.inner}`}>
          <div className={styles.side}>
            <p className="lp-label">Before you start</p>
            <p className="lp-body">
              Something else? <Link href="/contact">Ask us</Link>, or read the{' '}
              <Link href="/guides">guides</Link>.
            </p>
          </div>
          <div className={styles.answers}>
            <Questions plans={plans} />
          </div>
        </div>
      </div>
    </section>
  )
}

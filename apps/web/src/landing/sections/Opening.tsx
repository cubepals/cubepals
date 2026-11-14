// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The first screen: what Cubepals is in one sentence, why it is simpler in the next, the button,
 * and the island playing the sentence (a friend joins, the server wakes). Under the button, the
 * free trial, and Cubepals' own Arcade as it is right now, for anyone who would rather try first;
 * at its foot, what a server runs. Ink, with the island printed in paper on it. Not the island's
 * drawing, which is island/.
 */
import { LOADERS, type PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import type { PublicStatus } from '../../app/(public)/status'
import { ctaMark, seenMark } from '../../app/(public)/steps'
import { OPERATOR } from '../../legal/operator'
import { loaderLabel } from '../../lib/present'
import { Island } from '../island/Island'
import { Arcade } from './Arcade'
import styles from './opening.module.css'
import { trialSaid } from './said'

/** The address the drawn server has: one Cubepals keeps, so typing it leads somewhere good. */
const DRAWN_ADDRESS = `sunset-valley.${OPERATOR.playDomain}`

export function Opening({
  create,
  plans,
  arcade,
  bedrock,
}: {
  create: string
  plans: readonly PublicPlan[]
  arcade: PublicStatus | null
  bedrock: boolean
}) {
  return (
    <section className={styles.opening} data-tone="ink" aria-labelledby="opening" {...seenMark('opening')}>
      <div className={`lp-sheet ${styles.sheet}`}>
        <div className={`lp-pad ${styles.inner}`}>
          <div className={styles.words}>
            <p className="lp-label">Minecraft server hosting for friends</p>
            <h1 id="opening" className={`lp-display ${styles.headline}`}>
              <span>Your friends join.</span> <span className={styles.late}>Your server wakes&nbsp;up.</span>
            </h1>
            <p className={`lp-lede ${styles.lede}`}>
              Make a world in a few choices and send your friends one address. It starts when someone joins
              and sleeps when nobody’s on, so hours only count while it’s running.
            </p>
            <div className={styles.go} data-opening>
              <Link href={create} className="bk-btn bk-btn--lg bk-btn--inverse" {...ctaMark('hero_create')}>
                Create a server
              </Link>
              <a href="#price" className={styles.price} {...ctaMark('to_price')}>
                See pricing
              </a>
            </div>
            <ul className={styles.facts}>
              <li>{trialSaid(plans)}</li>
              {bedrock && <li>Java and Bedrock</li>}
              <li>Open source</li>
            </ul>
            <Arcade status={arcade} className={styles.arcade} />
          </div>
          <div className={styles.figure}>
            <Island address={DRAWN_ADDRESS} />
          </div>
        </div>
        <div className={`lp-pad ${styles.runs}`}>
          <p className={styles.runsLabel}>Runs</p>
          <ul className={styles.runsList}>
            <li>Java Edition</li>
            {bedrock && <li>Bedrock Edition</li>}
            {LOADERS.map((loader) => (
              <li key={loader}>{loaderLabel(loader)}</li>
            ))}
            <li>Modrinth packs</li>
            <li>Datapacks</li>
          </ul>
        </div>
      </div>
    </section>
  )
}

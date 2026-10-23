// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The landing page on a phone: a short page of its own, not the film made small. What Cubepals is,
 * in the film's own words, under two pictures of the chunk printed once each; what it costs; and
 * the button, which follows the reader at the foot of the screen between the two places the page
 * sets it. Every mark the funnels count is here under the same name as in the film.
 */
import Link from 'next/link'
import { SiteHeader } from '../../app/(public)/header'
import { ctaMark, seenMark } from '../../app/(public)/steps'
import { heroSmallPrint } from '../../lib/bedrock'
import { Follow } from '../Follow'
import type { Landed } from '../Landing'
import { lastSaid, PlansSaid, trialSaid } from '../sections/Plans'
import surface from '../sections/surface.module.css'
import { Address } from './Address'
import styles from './phone.module.css'
import { Still } from './Still'

/** The night's picture as printed beforehand, shown until the worker's own print is in. */
const night = { src: '/imagery/landing-still-night.png', width: 430, height: 323 }

export function Phone({ create, signedIn, plans, getPlan, bedrock }: Landed) {
  return (
    <main className={styles.page} data-phone>
      <section className={styles.night} data-tone="night" data-sky {...seenMark('top')}>
        <SiteHeader signedIn={signedIn} create={create} marks="nav" />
        <p className={styles.kicker}>Minecraft server hosting for friends</p>
        <h1 className={`bl-display ${styles.headline}`}>
          <span>Send your friends</span> <span>the address.</span> <span>They’re in.</span>
        </h1>
        <p className={`bl-lede ${styles.support}`}>
          Make a server in three decisions.{bedrock && ' Friends on PC, phones and tablets join it.'}
        </p>
        <div className={styles.go}>
          <Link href={create} className="bl-btn bl-btn--lg" {...ctaMark('hero_create')}>
            Create a server
          </Link>
          <p>
            <strong>{trialSaid(plans)}</strong>
            {heroSmallPrint(bedrock) && (
              <>
                <br />
                {heroSmallPrint(bedrock)}
              </>
            )}
          </p>
        </div>
        <Still still="night" first={night} className={styles.still} />
        <p className={styles.line} {...seenMark('the-address')}>
          Share the address.
        </p>
        <Address />
        <p className={styles.line} {...seenMark('edge')}>
          They join like any server.
        </p>
      </section>
      <section className={styles.day} data-tone="paper">
        <Still still="day" className={styles.still} />
        <p className={styles.line} {...seenMark('daybreak')}>
          No dashboard to open. No one to wait for.
        </p>
        <p className={styles.line} {...seenMark('what-it-asks')}>
          Pick what to play, and name it.
        </p>
        <p className={styles.line} {...seenMark('asleep')}>
          It saves the world before it stops.
        </p>
      </section>
      {plans.length >= 2 && (
        <section
          id="price"
          className={`${surface.plans} ${styles.plans}`}
          data-tone="paper"
          {...seenMark('price')}
        >
          <PlansSaid plans={plans} create={create} getPlan={getPlan} bedrock={bedrock} />
        </section>
      )}
      <section className={styles.last} data-tone="paper" data-closing {...seenMark('your-own')}>
        <h2 className="bl-display">Start a world with your friends</h2>
        <Link href={create} className="bl-btn bl-btn--lg" {...ctaMark('last_create')}>
          Create a server
        </Link>
        <p className={styles.under}>{lastSaid(plans)}</p>
      </section>
      <Follow create={create} />
    </main>
  )
}

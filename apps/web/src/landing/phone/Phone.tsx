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
import { ctaMark, seenMark } from '../../app/(public)/steps'
import { Follow } from '../Follow'
import { Nav } from '../film/Nav'
import type { Landed } from '../Landing'
import { PlansSaid } from '../sections/Plans'
import { Stars } from '../sections/Stars'
import surface from '../sections/surface.module.css'
import { Address } from './Address'
import styles from './phone.module.css'
import { Still } from './Still'

export function Phone({ create, signedIn, plans, getPlan }: Landed) {
  return (
    <main className={styles.page} data-phone>
      <section className={styles.night} data-tone="night" data-sky {...seenMark('top')}>
        <Stars className={styles.stars} />
        <Nav signedIn={signedIn} />
        <p className={styles.kicker}>Minecraft server hosting for friends</p>
        <h1 className={`bl-display ${styles.headline}`}>Send your friends the address. They’re in.</h1>
        <p className={`bl-lede ${styles.support}`}>
          Make a server in three decisions. Your friends join from the normal game, whenever they like, and
          nobody has to start it first.
        </p>
        <Still still="night" className={styles.still} />
        <div className={styles.go}>
          <Link href={create} className="bl-btn bl-btn--lg" {...ctaMark('hero_create')}>
            Create a server
          </Link>
          <p>
            Start with a free trial, no card needed.
            <br />
            For Minecraft: Java Edition.
          </p>
        </div>
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
          <PlansSaid plans={plans} create={create} getPlan={getPlan} />
        </section>
      )}
      <section className={styles.last} data-tone="paper" data-closing {...seenMark('your-own')}>
        <h2 className="bl-display">Start a world with your friends</h2>
        <Link href={create} className="bl-btn bl-btn--lg" {...ctaMark('last_create')}>
          Create a server
        </Link>
      </section>
      <Follow create={create} />
    </main>
  )
}

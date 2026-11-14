// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Cubepals' own servers, as they are right now, for anyone who would rather play than read: each
 * with what it is, whether it is up or asleep and how many are on it, and its address to copy.
 * Read on the server a moment ago (Landing.tsx), the way Browse reads them. A server that can't be
 * read is left out, and with none the section is too. Ink, as the first screen is.
 */
import Link from 'next/link'
import { type PublicStatus, playingLine } from '../../app/(public)/status'
import { ctaMark, seenMark } from '../../app/(public)/steps'
import { CopyField } from '../../ui/interactive'
import { StatusPill } from '../../ui/status'
import styles from './ours.module.css'

export function Ours({ ours }: { ours: readonly PublicStatus[] }) {
  if (ours.length === 0) return null
  return (
    <section className={styles.ours} data-tone="ink" aria-labelledby="ours" {...seenMark('ours')}>
      <div className="lp-sheet">
        <header className={`lp-pad ${styles.head}`}>
          <p className="lp-label">Try ours</p>
          <h2 id="ours" className={`lp-h2 lp-arrive ${styles.title}`}>
            Join one of ours. It wakes up for you.
          </h2>
          <p className="lp-lede lp-arrive">
            These are Cubepals’ own servers, open to anyone. Add one in Minecraft: if it’s asleep, it wakes
            when you join, the way yours will.
          </p>
        </header>
        <ul className={styles.list}>
          {ours.map((server) => (
            <li key={server.address} className={`${styles.server} lp-arrive`}>
              <div className={styles.top}>
                <h3 className="lp-h3">{server.name}</h3>
                <StatusPill status={server.state === 'awake' ? 'online' : 'sleeping'} />
              </div>
              <p className="lp-body">{server.description}</p>
              <p className={styles.now}>{playingLine(server)}</p>
              <div className={styles.copy}>
                <CopyField value={server.address} mark={ctaMark('copy_server')} />
              </div>
            </li>
          ))}
        </ul>
        <p className={`lp-pad ${styles.more}`}>
          <Link href="/browse" {...ctaMark('nav_browse')}>
            Browse every server people share
          </Link>
        </p>
      </div>
    </section>
  )
}

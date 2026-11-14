// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The drawn server's own card, as the servers page draws one: its picture, name and address, its
 * state in the product's own pill and words, how many are on it, and the one button the visitor
 * has: join it, or have everyone leave. Not the drawing it belongs to, which is Island.tsx.
 */
import { ctaMark } from '../../app/(public)/steps'
import { StatusPill } from '../../ui/status'
import styles from './island.module.css'
import type { Power } from './scene'

/** How many players the drawn server holds: the free trial's size. */
export const HOLDS = 5

/** What a server's row says while it sleeps and while it wakes: the product's own words. */
const SAID: Record<Power, (players: number) => string> = {
  sleeping: () => 'Wakes up when someone joins',
  starting: () => 'Waking your world',
  online: (players) => `${players} / ${HOLDS} players`,
  emptying: (players) => `${players} / ${HOLDS} players`,
}

const PILL = { sleeping: 'sleeping', starting: 'starting', online: 'online', emptying: 'online' } as const

export function Card({
  address,
  power,
  players,
  joined,
  press,
  announce,
}: {
  address: string
  power: Power
  players: number
  /** Whether the visitor has the server joined: the button then has everyone leave. */
  joined: boolean
  press: () => void
  /** Whether a change of state is said aloud: only once the visitor has pressed, never on its own. */
  announce: boolean
}) {
  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        {/* biome-ignore lint/performance/noImgElement: a pixel icon at its own size. */}
        <img src="/server-icons/grass.svg" width={32} height={32} alt="" className={styles.icon} />
        <div className={styles.cardName}>
          <p className={styles.name}>Sunset Valley</p>
          <p className={styles.address}>{address}</p>
        </div>
        <StatusPill status={PILL[power]} />
      </div>
      <div className={styles.cardFoot}>
        <p className={styles.detail} aria-live={announce ? 'polite' : 'off'}>
          {SAID[power](players)}
        </p>
        <button
          type="button"
          className="bk-btn bk-btn--sm bk-btn--primary"
          onClick={press}
          {...ctaMark('island_join')}
        >
          {joined ? 'Everyone leaves' : 'Join'}
        </button>
      </div>
    </div>
  )
}

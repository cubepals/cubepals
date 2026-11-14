// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The drawn server's own card: the design system's `ServerCard`, as the servers page draws one,
 * in the form for a card with a button of its own. Its state is in the product's pill and words,
 * with how many are on it, and its one button lets the visitor join it or have everyone leave.
 * Not the drawing it belongs to, which is Island.tsx.
 */
import { ctaMark } from '../../app/(public)/steps'
import { loaderLabel, SLEEPS_SOON, STOPPING } from '../../lib/present'
import { Button } from '../../ui/Button'
import { ServerCard } from '../../ui/product'
import type { PillStatus } from '../../ui/status'
import styles from './island.module.css'
import type { Power } from './scene'

/** How many players the drawn server holds: the free trial's size. */
export const HOLDS = 5

/** What a server's card says while it sleeps and while it wakes: the product's own words. */
const SAID: Record<Power, (players: number) => string> = {
  sleeping: () => 'Wakes up when someone joins',
  starting: () => 'Waking your world',
  online: (players) => `${players} / ${HOLDS} players`,
  // Once its last friend has left, it says what an empty server says while it waits to sleep.
  emptying: (players) =>
    players ? `${players} / ${HOLDS} players` : `0 / ${HOLDS} players · ${SLEEPS_SOON}`,
  stopping: () => STOPPING.detail,
}

const PILL = {
  sleeping: 'sleeping',
  starting: 'starting',
  online: 'online',
  emptying: 'online',
  stopping: STOPPING.pill,
} as const

/** The card's state for the drawn server's, as the product says each: a stopping server's included. */
export function cardOf(
  power: Power,
  players: number,
): { status: PillStatus; label?: string; detail: string } {
  const shown = { status: PILL[power], detail: SAID[power](players) }
  return power === 'stopping' ? { ...shown, label: STOPPING.label } : shown
}

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
  const shown = cardOf(power, players)
  return (
    <div className={styles.card}>
      <ServerCard
        name="Sunset Valley"
        status={shown.status}
        {...(shown.label ? { statusLabel: shown.label } : {})}
        loader={loaderLabel('vanilla')}
        detail={shown.detail}
        address={address}
        live={announce}
        action={
          <Button variant="primary" size="sm" onClick={press} {...ctaMark('island_join')}>
            {joined ? 'Everyone leaves' : 'Join'}
          </Button>
        }
      />
    </div>
  )
}

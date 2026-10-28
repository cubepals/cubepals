// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What the first screen says round its button, the same in the film and on a phone: the line under
 * the headline, and the trust facts under the button, one line each. Each fact holds on every plan,
 * the free trial's included: every plan keeps its last sessions to go back to (as many as its card
 * says), a world can be downloaded and one brought in, and the code is public. Not
 * the headline or the button, which each form sets in its own type, nor the plans' details.
 */
import { SOURCE_URL } from '../ui/brand'
import { OutLink } from '../ui/out-link'
import styles from './first-words.module.css'

/** The line under the headline: why it is simple, and who can join where Bedrock is on. */
export function Support({ bedrock, className }: { bedrock: boolean; className: string }) {
  return (
    <p className={className}>
      You shouldn’t have to become a server admin to play with friends. Make a server in a few decisions.
      {bedrock && ' Friends on PC, phones and tablets join it.'}
    </p>
  )
}

export function Trust({ className = '' }: { className?: string }) {
  return (
    <ul className={`${styles.trust} ${className}`}>
      <li>
        <Tick />
        Go back to any of your last sessions
      </li>
      <li>
        <Tick />
        Your world is yours to download
      </li>
      <li>
        <Tick />
        Bring a world you already have
      </li>
      <li>
        <Tick />
        Open source: <OutLink href={SOURCE_URL}>read the code</OutLink>
      </li>
    </ul>
  )
}

/** The tick before a fact, for the eye only. */
const Tick = () => (
  <span className={styles.tick} aria-hidden="true">
    ✓
  </span>
)

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * A sleeping server's snore, three letters rising from its chimney, set where the chimney is on
 * the picture (fractions of its width and height). Still where less motion is asked for.
 */
import styles from './island.module.css'

export function Snore({ at }: { at: readonly [number, number] }) {
  return (
    <span
      className={styles.snore}
      style={{ left: `${(at[0] * 100).toFixed(2)}%`, top: `${(at[1] * 100).toFixed(2)}%` }}
      aria-hidden
    >
      <i>z</i>
      <i>z</i>
      <i>Z</i>
    </span>
  )
}

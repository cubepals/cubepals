// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/** The film's server's address, in the game's own field, already typed. */
import { addressOf, EXAMPLE_NAME } from '../sections/choice'
import styles from './phone.module.css'

export function Address() {
  return (
    <p className={styles.address}>
      <span className={styles.label}>Server Address</span>
      <span className={styles.field}>{addressOf(EXAMPLE_NAME)}</span>
    </p>
  )
}

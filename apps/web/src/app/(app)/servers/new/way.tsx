// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One way to play on the create-server page, as a row to pick. It does not decide what picking
 * it does or whether the plan runs it: the page passes that in.
 */
import type { Ref } from 'react'
import styles from './create.module.css'
import { type Picture, Thumb } from './thumb'

/**
 * A way to play, as a row: its item, its name and a line of what it is. One the plan can't run
 * says why in that line, which stays readable while the rest of the row goes quiet.
 */
export function Way({
  picture,
  title,
  blurb,
  meta,
  why,
  picked,
  busy,
  disabled,
  onPick,
  ref,
}: {
  picture: Picture
  title: string
  blurb: string
  /** A quiet line under the blurb, where a way to play has more worth saying. */
  meta?: string
  /** Why the plan doesn't run it, in place of the blurb. */
  why: string | null
  picked: boolean
  busy: boolean
  disabled: boolean
  onPick: () => void
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={styles.row}
      aria-pressed={picked}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onPick}
    >
      <Thumb picture={picture} state={busy ? 'busy' : picked ? 'picked' : undefined} />
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={why === null ? styles.rowBlurb : styles.rowWhy}>{why ?? blurb}</span>
        {meta !== undefined && why === null && <span className={styles.rowMeta}>{meta}</span>}
      </span>
    </button>
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * A whole number chosen on a slider, with its value in words and its scale measured under it.
 * Only the game form's numbers use it (`game-numbers.tsx`).
 */

import { type CSSProperties, type ReactNode, useId } from 'react'
import styles from './range-field.module.css'

/**
 * A whole number chosen on a slider: the label and the value read big on one line, a thin Ink
 * track filled to a square thumb, and its ends and one mark (Minecraft's own value) measured under
 * it. The keyboard's arrows step by one, as the native slider does. The value's room is the
 * widest it can be, in the monospaced face, so neither it nor the label moves while it slides. A value the bounds no longer
 * allow (a plan's cap after a change of plan) still reads as it is, with the error under it.
 */
export function RangeField({
  label,
  value,
  min,
  max,
  said,
  mark,
  help,
  error,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  /** The value in words: "10 chunks", "Off". */
  said: (value: number) => string
  /** A value worth finding again, with what it is: Minecraft's own. Shown only within the bounds. */
  mark?: { value: number; label: string }
  help?: ReactNode
  error?: string | null
  onChange: (value: number) => void
}) {
  const id = useId()
  const note = `${id}-note`
  const span = Math.max(1, max - min)
  const at = (v: number) => `${((Math.min(max, Math.max(min, v)) - min) / span) * 100}%`
  const marked = mark && mark.value > min && mark.value < max ? mark : undefined
  return (
    <div className={styles.field} data-invalid={error ? true : undefined}>
      <div className={styles.head}>
        <label className="bk-field__label" htmlFor={id}>
          {label}
        </label>
        <output
          htmlFor={id}
          className={`${styles.value} bk-num`}
          style={{ minInlineSize: `${Math.max(said(min).length, said(max).length, said(value).length)}ch` }}
        >
          {said(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className={styles.range}
        style={{ '--fill': at(value) } as CSSProperties}
        min={min}
        max={max}
        step={1}
        value={Math.min(max, Math.max(min, value))}
        aria-valuetext={said(value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || help ? note : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className={`${styles.scale} type-mono-sm`} aria-hidden>
        <span className={styles.end}>{min}</span>
        {marked && (
          <span className={styles.mark} style={{ insetInlineStart: at(marked.value) }}>
            {marked.label}
          </span>
        )}
        <span className={styles.end}>{max}</span>
      </div>
      {error ? (
        <p id={note} className="bk-field__error" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={note} className="bk-field__help">
          {help}
        </p>
      ) : null}
    </div>
  )
}

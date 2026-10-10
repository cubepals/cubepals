// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One question of the create-server page: its frame, its heading, and how it opens once the
 * questions before it are answered. What goes inside each question lives with the page and the
 * pickers it uses, not here.
 */
import { Check } from 'lucide-react'
import { type CSSProperties, type ReactNode, type Ref, useId } from 'react'
import styles from './create.module.css'

/**
 * One question. Until the ones before it are answered it is there to see, so nobody wonders
 * what comes next, but quiet and out of reach: dimmed, and inert, so nothing in it takes focus.
 */
export function Part({
  index,
  title,
  open,
  done,
  children,
  ref,
}: {
  index: number
  title: string
  open: boolean
  done: boolean
  children: ReactNode
  ref?: Ref<HTMLElement>
}) {
  const heading = useId()
  return (
    <section
      ref={ref}
      className={`bk-enter ${styles.part}`}
      style={{ '--i': index } as CSSProperties}
      data-closed={!open || undefined}
      aria-labelledby={heading}
    >
      <h2 id={heading} className={`type-heading-md ${styles.partTitle}`}>
        {title}
        {done && <Check size={20} strokeWidth={2.25} className={styles.mark} aria-hidden />}
      </h2>
      <div className={styles.partBody} inert={!open || undefined}>
        {children}
      </div>
    </section>
  )
}

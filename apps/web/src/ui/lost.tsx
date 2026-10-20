// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The page for an error Next can still render: the 404 (app/not-found.tsx) and a page of the app
 * that failed (app/(app)/error.tsx). A figure, a line that says it isn't the visitor's fault, the
 * way on (home, try again, the servers), and how to reach us. The words are errors/copy.ts's, the
 * same as the standalone pages say.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { LOST, type LostKind, SUPPORT } from '../errors/copy'
import styles from './lost.module.css'

/** Which figure stands by each: Moss, shrugging, for a page not found; Kai for a page that broke. */
const FIGURE: Partial<Record<LostKind, string>> = {
  notFound: '/errors/moss-shrugging.png',
  broken: '/errors/kai-shrugging.png',
}

export function Lost({
  kind,
  onRetry,
  children,
}: {
  kind: 'notFound' | 'broken'
  /** Offered as "Try again" where asking again could help. */
  onRetry?: () => void
  /** What else to do next, as links. */
  children?: ReactNode
}) {
  const copy = LOST[kind]
  return (
    <section className={styles.lost} aria-labelledby="lost-title">
      {/* biome-ignore lint/performance/noImgElement: a fixed-size dithered figure, which Next's image pipeline would blur; lazy, so a page that only carries this one in its tree for a 404 never preloads it */}
      <img
        src={FIGURE[kind]}
        alt=""
        width={78}
        height={105}
        loading="lazy"
        className={styles.figure}
        draggable={false}
      />
      <h1 id="lost-title" className={`type-display-md ${styles.title}`}>
        {copy.title}
      </h1>
      <p>{copy.line}</p>
      <p className={styles.row}>
        {onRetry && (
          <button type="button" className="bk-btn bk-btn--primary bk-btn--md" onClick={onRetry}>
            Try again
          </button>
        )}
        <Link href="/" className={`bk-btn ${onRetry ? 'bk-btn--outline' : 'bk-btn--primary'} bk-btn--md`}>
          Go home
        </Link>
        {children}
      </p>
      <p className={styles.fine}>
        Still stuck? Write to <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>, or see{' '}
        <Link href="/contact">how to reach us</Link>.
      </p>
    </section>
  )
}

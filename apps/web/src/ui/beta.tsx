// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * How Cubepals says it is in beta: a small tag beside the wordmark, and a banner across the top
 * of sign-in, sign-up and the app on a browser's first visit (not the landing page, whose film
 * owns the top of the screen). Both lead to the letter at `/beta`, its indigo growing from them
 * (letter-motion.ts). Each shows only while the root layout marks the page (lib/beta.ts), so the
 * one switch takes them both away; the banner also only until this browser closes it or opens
 * the letter. Not the letter itself, which is its page's (app/(public)/beta).
 */
import { X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { markBetaRead } from '../lib/beta'
import styles from './beta.module.css'
import { openLetter } from './letter-motion'

/** The wordmark's link with the tag beside it. A link can't hold another, so they sit side by side. */
export function WithBeta({ children }: { children: ReactNode }) {
  const router = useRouter()
  return (
    <span className={styles.with}>
      {children}
      <Link
        href="/beta"
        className={styles.tag}
        aria-label="Cubepals is in beta: read the letter"
        onClick={(event) => openLetter(event, 'tag', () => router.push('/beta'))}
      >
        beta
      </Link>
    </span>
  )
}

/** The banner on a first visit: one line, the way to the letter, and a way to close it. */
export function BetaBanner() {
  const router = useRouter()
  return (
    <section className={styles.banner} aria-label="Beta">
      <p className={styles.line}>
        Cubepals is in beta. Thanks for being here early.{' '}
        {/* Opening the letter puts the banner away (its page's `Read`), after the fill has left it. */}
        <Link
          href="/beta"
          className={styles.read}
          onClick={(event) => openLetter(event, 'banner', () => router.push('/beta'))}
        >
          Read our letter
        </Link>
      </p>
      <button type="button" className={styles.close} aria-label="Close" onClick={markBetaRead}>
        <X size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </section>
  )
}

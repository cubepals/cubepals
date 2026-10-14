// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * How Cubepals says it is in beta: a small tag beside the wordmark, and a banner across the top
 * on a browser's first visit. Both lead to the letter at `/beta`. Each shows only while the root
 * layout marks the page (lib/beta.ts), so the one switch takes them both away; the banner also
 * only until this browser closes it or opens the letter. Not the letter itself, which is its
 * page's (app/(public)/beta).
 */
import { X } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { markBetaRead } from '../lib/beta'
import styles from './beta.module.css'

/** The wordmark's link with the tag beside it. A link can't hold another, so they sit side by side. */
export function WithBeta({ children }: { children: ReactNode }) {
  return (
    <span className={styles.with}>
      {children}
      <Link href="/beta" className={styles.tag} aria-label="Cubepals is in beta: read the letter">
        beta
      </Link>
    </span>
  )
}

/** The banner on a first visit: one line, the way to the letter, and a way to close it. */
export function BetaBanner() {
  return (
    <section className={styles.banner} aria-label="Beta" data-banner>
      <p className={styles.line}>
        Cubepals is in beta. Thanks for being here early.{' '}
        <Link href="/beta" className={styles.read} onClick={markBetaRead}>
          Read our letter
        </Link>
      </p>
      <button type="button" className={styles.close} aria-label="Close" onClick={markBetaRead}>
        <X size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </section>
  )
}

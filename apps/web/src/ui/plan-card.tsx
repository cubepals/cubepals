// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * A paid plan's card on the public pages, the same on /pricing, the landing and the phone's
 * landing: printed in the landing's ink on paper, in a stepped frame (landing/blocks.css), with
 * the stepped buttons at its foot. The plan the free trial starts is the paper card, the other the
 * ink one. Its words are plan-details.tsx's. Not for the account page, which has `PlanCard`.
 *
 * The cards share their rows (plan-card.module.css), so side by side the buttons line up whether
 * or not either card's details are open.
 */
import type { PublicPlan } from '@blockly/contracts'
import { Check } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import styles from './plan-card.module.css'
import { offerPitch, offerPoints, PlanDetails } from './plan-details'
import { dollars } from './plans'

type Mark = Readonly<Record<`data-${string}`, string>>

/** The cards, side by side where they fit and one above the other where they don't. */
export function PlanCards({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`bl-print ${styles.cards} ${className}`}>{children}</div>
}

/** One paid plan: its name, price, pitch and lines, the rest in its details, and its buttons. */
export function OfferCard({
  plan,
  plans,
  trial,
  bedrock,
  year,
  mark,
  children,
}: {
  plan: PublicPlan
  plans: readonly PublicPlan[]
  /** The free trial, on the plan it starts: that card is the paper one. */
  trial?: PublicPlan | undefined
  /** Whether Bedrock is on, for Core's lines (`lib/bedrock.ts`). */
  bedrock: boolean
  /** The year's line as a link to buy it, where the page has one. */
  year?: ReactNode
  /** The page's mark for the card coming into view (app/(public)/steps.ts). */
  mark?: Mark
  /** The card's buttons: `PlanButtons`. */
  children: ReactNode
}) {
  return (
    <section
      className={`bl-frame ${styles.card} ${trial ? '' : styles.paid}`}
      aria-label={plan.name}
      data-paid={trial ? undefined : ''}
      {...mark}
    >
      <h3 className={styles.name}>{plan.name}</h3>
      <p className={styles.price}>
        <span className="bl-num">{dollars(plan.monthlyPriceCents)}</span>
        <small> a month</small>
      </p>
      <p className={styles.pitch}>{offerPitch(plan, plans)}</p>
      <ul className={styles.points}>
        {offerPoints(plan, bedrock).map((point) => (
          <li key={point}>
            <Check size={18} strokeWidth={2.5} aria-hidden />
            {point}
          </li>
        ))}
      </ul>
      <PlanDetails plan={plan} trial={trial} year={year} className={styles.details} />
      {children}
    </section>
  )
}

/**
 * A card's buttons. On the plan the trial starts: Start free, the ink block, with what the trial
 * is and the plan itself under it. On the other: its plan, the lit block. A plan nothing sells yet
 * says so.
 */
export function PlanButtons({
  name,
  available,
  get,
  getMark,
  start,
}: {
  name: string
  /** False for a paid plan nothing sells here yet. */
  available: boolean
  /** Where the plan's button goes. */
  get: string
  getMark?: Mark
  /** On the plan the trial starts: where Start free goes, and what the trial is. */
  start?: { href: string; mark?: Mark; free: string } | undefined
}) {
  if (start)
    return (
      <>
        <Link href={start.href} className={`bl-btn ${styles.action}`} {...start.mark}>
          Start free
        </Link>
        <div className={styles.under}>
          <p className={styles.free}>{start.free}</p>
          {available && (
            <Link href={get} className={styles.get} {...getMark}>
              Get {name}
            </Link>
          )}
        </div>
      </>
    )
  if (!available)
    return (
      <span className={`bl-btn ${styles.action}`} aria-disabled="true">
        Not available yet
      </span>
    )
  return (
    <Link href={get} className={`bl-btn bl-btn--lit ${styles.action}`} {...getMark}>
      Get {name}
    </Link>
  )
}

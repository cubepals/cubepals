// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * A paid plan's card on the public pages, the same on /pricing, the landing and the phone's
 * landing, printed in the landing's ink on paper in a stepped frame (landing/blocks.css). One
 * surface, in the order people read a price: the plan's picture and name, what it costs, its one
 * button, a few lines of what you get (`PixelIcon`), and the rest in its details. The plan the free
 * trial starts is the paper card, the other the ink one. Its words are plan-details.tsx's. Not for
 * the account page, which has `PlanCard`.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { PixelIcon } from './pixel-icon'
import styles from './plan-card.module.css'
import { freeSaid, offerPitch, offerPoints, PlanDetails } from './plan-details'
import { dollars, forSale } from './plans'

type Mark = Readonly<Record<`data-${string}`, string>>
/** Where a link on the card goes, and the page's mark for it (app/(public)/steps.ts). */
export type CardLink = { href: string; mark?: Mark }

/**
 * The cards, side by side where they fit and one above the other where they don't. The page sets
 * the game face's fonts around them (landing/fonts.ts): the landing does on `.bl`.
 */
export function PlanCards({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`bl-print ${styles.cards} ${className}`}>{children}</div>
}

/** The plan's picture: grass for plain Minecraft, an anvil for mods. */
const pictureOf = (plan: PublicPlan) =>
  plan.mods ? (
    <span className={`${styles.picture} ${styles.anvil}`}>
      <PixelIcon name="anvil" />
    </span>
  ) : (
    // biome-ignore lint/performance/noImgElement: a 16-pixel drawing, shown as it is
    <img className={styles.picture} src="/server-icons/grass.svg" alt="" width={16} height={16} />
  )

/** One paid plan. Its links are given by the page: what they are depends on who is reading. */
export function OfferCard({
  plan,
  plans,
  trial,
  bedrock,
  mark,
  start,
  checkout,
}: {
  plan: PublicPlan
  plans: readonly PublicPlan[]
  /** The free trial, on the plan it starts: that card is the paper one. */
  trial?: PublicPlan | undefined
  /** Whether Bedrock is on, for Core's lines (`lib/bedrock.ts`). */
  bedrock: boolean
  /** The page's mark for the card coming into view. */
  mark?: Mark
  /** On the plan the trial starts: where Start free goes. */
  start?: CardLink | undefined
  /** Where buying the plan goes, by the month or for a year. */
  checkout: (term: 'month' | 'year') => CardLink
}) {
  const sells = forSale(plan)
  const month = sells ? checkout('month') : undefined
  const year = sells && plan.yearlyPriceCents ? checkout('year') : undefined
  return (
    <section
      className={`bl-frame ${styles.card} ${trial ? '' : styles.paid}`}
      aria-label={plan.name}
      data-paid={trial ? undefined : ''}
      {...mark}
    >
      <div className={styles.head}>
        {pictureOf(plan)}
        <p className={`bl-game ${styles.name}`}>{plan.name}</p>
        <p className={`type-body ${styles.pitch}`}>{offerPitch(plan, plans)}</p>
      </div>
      <div className={styles.offer}>
        <p className={styles.price}>
          {trial ? (
            <strong>{freeSaid(trial)}</strong>
          ) : (
            <>
              <strong>{dollars(plan.monthlyPriceCents)}</strong> a month
            </>
          )}
        </p>
        <Then plan={plan} trial={trial} year={year} />
      </div>
      <CardButton name={plan.name} start={trial ? start : undefined} month={month} />
      <ul className={styles.points}>
        {offerPoints(plan, bedrock).map((point) => (
          <li key={point.said} className="type-body">
            <PixelIcon name={point.kind} size={24} />
            {point.said}
          </li>
        ))}
      </ul>
      <PlanDetails
        plan={plan}
        trial={trial}
        // A year that can be bought is said under the price.
        year={year ? false : undefined}
        marker={<PixelIcon name="chevron" size={16} />}
        className={`type-body ${styles.details}`}
      />
    </section>
  )
}

/**
 * The one quiet line under the price: what the trial's plan costs after it, or the year paid at
 * once where it is sold.
 */
function Then({
  plan,
  trial,
  year,
}: {
  plan: PublicPlan
  trial?: PublicPlan | undefined
  year?: CardLink | undefined
}) {
  if (trial)
    return (
      <p className={`type-body ${styles.then}`}>No card, then {dollars(plan.monthlyPriceCents)} a month</p>
    )
  if (!year || !plan.yearlyPriceCents) return null
  return (
    <p className={`type-body ${styles.then}`}>
      <Link href={year.href} {...year.mark}>
        Or {dollars(plan.yearlyPriceCents)} for a year, paid once
      </Link>
    </p>
  )
}

/**
 * The card's one button, as wide as the card: Start free, the ink block, on the plan the trial
 * starts; the plan itself, the lit block, on the other; or that nothing sells it yet.
 */
function CardButton({
  name,
  start,
  month,
}: {
  name: string
  start?: CardLink | undefined
  month?: CardLink
}) {
  if (start)
    return (
      <Link href={start.href} className={`bl-btn bl-btn--lg ${styles.action}`} {...start.mark}>
        Start free
      </Link>
    )
  if (!month)
    return (
      <span className={`bl-btn bl-btn--lg ${styles.action}`} aria-disabled="true">
        Not available yet
      </span>
    )
  return (
    <Link
      href={month.href}
      className={`bl-btn bl-btn--lg bl-btn--lit ${styles.action} ${styles.lit}`}
      {...month.mark}
    >
      Get {name}
    </Link>
  )
}

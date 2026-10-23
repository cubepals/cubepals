// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * A paid plan's card on the public pages, the same on /pricing, the landing and the phone's
 * landing, printed in the landing's ink on paper in a stepped frame (landing/blocks.css). It opens
 * with the plan as a server in the multiplayer list (`ServerRow`) on an ink panel with its offer
 * and its button, then a dithered edge, then what you get, a picture to each line
 * (`PixelIcon`), the rest in its details, and one more way to buy it at its foot. The plan the
 * free trial starts is the paper card, the other the ink one. Its words are plan-details.tsx's.
 * Not for the account page, which has `PlanCard`.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { PixelIcon } from './pixel-icon'
import styles from './plan-card.module.css'
import { freeSaid, offerPitch, offerPoints, PlanDetails, serverMessage } from './plan-details'
import { dollars, forSale } from './plans'
import { ServerRow } from './server-row'

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

/** The plan's picture in the list: grass for plain Minecraft, an anvil for mods. */
const pictureOf = (plan: PublicPlan) =>
  plan.mods ? (
    <span className={styles.anvil}>
      <PixelIcon name="anvil" />
    </span>
  ) : (
    // biome-ignore lint/performance/noImgElement: a 16-pixel drawing, shown as it is
    <img src="/server-icons/grass.svg" alt="" width={16} height={16} />
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
  /** Whether Bedrock is on, for Core's message and lines (`lib/bedrock.ts`). */
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
  const [free, noCard] = trial ? freeSaid(trial) : ['', '']
  return (
    <section
      className={`bl-frame ${styles.card} ${trial ? '' : styles.paid}`}
      aria-label={plan.name}
      data-paid={trial ? undefined : ''}
      {...mark}
    >
      <div className={styles.panel}>
        <ServerRow
          picture={pictureOf(plan)}
          name={plan.name}
          message={serverMessage(plan, plans, bedrock)}
          players={{ on: 0, max: plan.maxPlayers }}
        />
        {trial ? (
          <p className={styles.offer}>
            <strong className="type-heading-md">{free}</strong>
            {noCard}
          </p>
        ) : (
          <p className={styles.offer}>
            <strong className="type-heading-md">{dollars(plan.monthlyPriceCents)}</strong> a month
          </p>
        )}
        <PanelButton name={plan.name} start={trial ? start : undefined} month={month} />
      </div>
      <div className={`bl-dither ${styles.edge}`} data-level="3" />
      <div className={styles.body}>
        <p className={`type-body-lg ${styles.pitch}`}>
          {trial ? (
            <>
              Then <strong className="type-heading-md">{dollars(plan.monthlyPriceCents)}</strong> a month,
              when you want to keep playing.
            </>
          ) : (
            offerPitch(plan, plans)
          )}
        </p>
        <ul className={styles.points}>
          {offerPoints(plan, bedrock).map((point) => (
            <li key={point.said} className="type-body">
              <PixelIcon name={point.kind} />
              {point.said}
            </li>
          ))}
        </ul>
        <PlanDetails
          plan={plan}
          trial={trial}
          // A year that can be bought is said at the card's foot.
          year={year ? false : undefined}
          marker={<PixelIcon name="chevron" size={16} />}
          className={`type-body ${styles.details}`}
        />
        {trial && month ? (
          <p className={`type-body ${styles.foot}`}>
            <span className={styles.ask}>Ready to keep it?</span>
            <Link href={month.href} {...month.mark}>
              Get {plan.name} now
            </Link>
          </p>
        ) : null}
        {!trial && year && plan.yearlyPriceCents ? (
          <p className={`type-body ${styles.foot}`}>
            <span className={styles.ask}>Want a year?</span>
            <Link href={year.href} {...year.mark}>
              {dollars(plan.yearlyPriceCents)}, paid once
            </Link>
          </p>
        ) : null}
      </div>
    </section>
  )
}

/**
 * The panel's button, as wide as the panel: Start free, the paper block, on the plan the trial
 * starts; the plan itself, the lit block, on the other; or that nothing sells it yet.
 */
function PanelButton({
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

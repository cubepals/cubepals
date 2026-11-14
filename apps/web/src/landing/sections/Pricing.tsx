// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What it costs, high on the page and said plainly: the paid plans as the pricing page sets them
 * (a card each, from the plan table the control plane enforces, the free trial on the first), and
 * beside them how far a plan's hours go at each size, worked out as the size is picked (Hours.tsx).
 * With no plans to show (the control plane can't be reached) the section is left out.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import { ctaMark, planMark, seenMark } from '../../app/(public)/steps'
import { OfferCard, PlanCards } from '../../ui/plan-card'
import { cardsOf, plansSaid } from '../../ui/plan-details'
import { sizesOf } from '../../ui/plans'
import { Hours } from './Hours'
import styles from './pricing.module.css'

export function Pricing({
  plans,
  create,
  getPlan,
  bedrock,
}: {
  plans: PublicPlan[]
  create: string
  /** Where a paid plan's button leads, by plan key. */
  getPlan: (key: string, term?: 'month' | 'year') => string
  bedrock: boolean
}) {
  const { trial, cards, starter } = cardsOf(plans)
  if (cards.length === 0) return null
  // The plan with the most sizes is the one whose hours go differently by size.
  const sized = cards.reduce((most, plan) => (sizesOf(plan).length > sizesOf(most).length ? plan : most))
  return (
    <section
      id="price"
      className={styles.pricing}
      data-tone="paper"
      aria-labelledby="price-title"
      {...seenMark('price')}
    >
      <div className="lp-sheet">
        <header className={`lp-pad ${styles.head}`}>
          <p className="lp-label">Pricing</p>
          <h2 id="price-title" className={`lp-h2 lp-arrive ${styles.title}`}>
            {plansSaid(plans)}.
          </h2>
          <p className="lp-lede lp-arrive">
            Hours only count while your server is running, and everyone on it shares them. Nothing is charged
            past your plan unless you allow it.
          </p>
        </header>
        <div className={`lp-pad ${styles.body}`}>
          <PlanCards className={styles.cards}>
            {cards.map((plan) => (
              <OfferCard
                key={plan.key}
                plan={plan}
                plans={plans}
                trial={plan === starter ? trial : undefined}
                bedrock={bedrock}
                mark={seenMark(`plan_${plan.key}`)}
                start={{ href: create, mark: ctaMark('plans_create') }}
                checkout={(term) => ({ href: getPlan(plan.key, term), mark: planMark(plan.key, term) })}
              />
            ))}
          </PlanCards>
          {sizesOf(sized).length > 1 && <Hours plan={sized} />}
        </div>
        <p className={`lp-pad ${styles.more}`}>
          <Link href="/pricing">Everything in each plan</Link>
        </p>
      </div>
    </section>
  )
}

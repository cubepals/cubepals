// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The paid plans, from the plan table the control plane enforces, set as a card each.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import { ctaMark, planMark, seenMark } from '../../app/(public)/steps'
import { OfferCard, PlanCards } from '../../ui/plan-card'
import { cardsOf, plansSaid } from '../../ui/plan-details'
import { eachOf, priceOf } from '../../ui/plans'
import { Section } from '../kit'
import styles from './surface.module.css'

/** The free trial in a few words, from its own hours: "20 hours free, no card." */
export function trialSaid(plans: readonly PublicPlan[]): string {
  const free = plans.find((plan) => plan.monthlyPriceCents === 0)
  return free?.totalHours ? `${free.totalHours} hours free, no card.` : 'Start with a free trial, no card.'
}

/** The trial, and what the paid plan comes to for a group: the line under the last button. */
export function lastSaid(plans: readonly PublicPlan[]): string {
  const paid = plans.find((plan) => plan.monthlyPriceCents > 0)
  const shared = paid ? eachOf(paid) : null
  if (!paid || !shared) return trialSaid(plans)
  return `${trialSaid(plans)} ${paid.name} is ${priceOf(paid.monthlyPriceCents)}, ${shared.each} each for ${shared.friends} friends.`
}

/**
 * The plans, from the plan table the control plane enforces, so nothing here can promise what a
 * server won't do. The last thing a player needs; after it the page turns, and digs. With no plans
 * to show (the control plane can't be reached) the section is left out. Everyone is already in on
 * the grass below it, as on the closing it hands over to, so nobody arrives during the flight.
 * The header, which has no ground of its own over the picture, never draws over the cards: the
 * section keeps a strip of its own ground under it while it scrolls by (surface.module.css).
 */
export function Plans({
  plans,
  create,
  getPlan,
  bedrock,
}: {
  plans: PublicPlan[]
  create: string
  /** Where a paid plan's button leads, by plan key. */
  getPlan: (key: string, term?: 'month' | 'year') => string
  /** Whether Bedrock is on (`lib/bedrock.ts`). */
  bedrock: boolean
}) {
  if (cardsOf(plans).cards.length === 0) return null
  return (
    <Section
      id="price"
      name="What it costs"
      tone="paper"
      y={66}
      shot={{ az: 30, el: 54, span: 34, turn: 16 }}
      act="friends"
      className={styles.plans}
    >
      <div className={styles.clear} aria-hidden />
      <PlansSaid plans={plans} create={create} getPlan={getPlan} bedrock={bedrock} />
    </Section>
  )
}

/**
 * What the plans section says, wherever it is set: the heading, a card to each paid plan (the first
 * starting with the free trial, on the paper card; ui/plan-card.tsx), and the line under them. The film sets it in
 * its section; the phone's page sets it in its own.
 */
export function PlansSaid({
  plans,
  create,
  getPlan,
  bedrock,
}: {
  plans: PublicPlan[]
  create: string
  getPlan: (key: string, term?: 'month' | 'year') => string
  bedrock: boolean
}) {
  const { trial, cards, starter } = cardsOf(plans)
  return (
    <>
      <h2 className="bl-h2">{plansSaid(plans)}</h2>
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
      <p className={`bl-body ${styles.hours}`}>
        <Link href="/pricing" className={styles.more}>
          Full pricing
        </Link>
      </p>
    </>
  )
}

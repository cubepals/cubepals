// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The paid plans, from the plan table the control plane enforces, set as a card each.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import { ctaMark, planMark, seenMark } from '../../app/(public)/steps'
import { cardsOf, freeSaid, offerPitch, offerPoints, PlanDetails, plansSaid } from '../../ui/plan-details'
import { eachOf, forSale, priceOf } from '../../ui/plans'
import { Section } from '../kit'
import styles from './surface.module.css'

const dollars = (cents: number): string => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

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
  getPlan: (key: string) => string
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
      <PlansSaid plans={plans} create={create} getPlan={getPlan} bedrock={bedrock} />
    </Section>
  )
}

/**
 * What the plans section says, wherever it is set: the heading, a card to each paid plan (the first
 * starting with the free trial, on the light card), and the line under them. The film sets it in
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
  getPlan: (key: string) => string
  bedrock: boolean
}) {
  const { trial, cards, starter } = cardsOf(plans)
  return (
    <>
      <h2 className="bl-h2">{plansSaid(plans)}</h2>
      <div className={styles.cards}>
        {cards.map((plan) => {
          const startsTrial = plan === starter ? trial : undefined
          return (
            <section
              key={plan.key}
              className={`bl-frame ${startsTrial ? '' : `bl-frame--solid ${styles.paid}`} ${styles.card}`}
              aria-label={plan.name}
              {...seenMark(`plan_${plan.key}`)}
            >
              <h3 className={styles.name}>{plan.name}</h3>
              <p className={styles.price}>
                <span className="bl-num">{dollars(plan.monthlyPriceCents)}</span>
                <small> a month</small>
              </p>
              <p className={styles.pitch}>{offerPitch(plan, plans)}</p>
              <ul className={styles.points}>
                {offerPoints(plan, bedrock).map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <PlanDetails plan={plan} trial={startsTrial} className={styles.details} />
              {startsTrial ? (
                <>
                  <Link href={create} className={`bl-btn ${styles.action}`} {...ctaMark('plans_create')}>
                    Start free
                  </Link>
                  <p className={styles.free}>{freeSaid(startsTrial)}</p>
                  {forSale(plan) && (
                    <Link href={getPlan(plan.key)} className={styles.more} {...planMark(plan.key, 'month')}>
                      Get {plan.name}
                    </Link>
                  )}
                </>
              ) : (
                <PlanButton plan={plan} getPlan={getPlan} />
              )}
            </section>
          )
        })}
      </div>
      <p className={`bl-body ${styles.hours}`}>
        <Link href="/pricing" className={styles.more}>
          Full pricing
        </Link>
      </p>
    </>
  )
}

/** A paid card's button: to the plan's checkout, or that the plan isn't for sale yet. */
function PlanButton({ plan, getPlan }: { plan: PublicPlan; getPlan: (key: string) => string }) {
  if (!forSale(plan))
    return (
      <span className={`bl-btn ${styles.action}`} aria-disabled="true">
        Not available yet
      </span>
    )
  return (
    <Link
      href={getPlan(plan.key)}
      className={`bl-btn bl-btn--lit ${styles.action}`}
      {...planMark(plan.key, 'month')}
    >
      Get {plan.name}
    </Link>
  )
}

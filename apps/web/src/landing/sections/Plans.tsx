// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The plans, from the plan table the control plane enforces, set as two cards.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import { ctaMark, planMark, seenMark } from '../../app/(public)/steps'
import { eachOf, forSale, PlanPoint, pitchOf, planPoints, priceOf } from '../../ui/plans'
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
  if (plans.length < 2) return null
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
 * What the plans section says, wherever it is set: the heading, a card to a plan, and the line
 * under them. The film sets it in its section; the phone's page sets it in its own.
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
  const paid = plans.find((plan) => plan.monthlyPriceCents > 0)
  return (
    <>
      <h2 className="bl-h2">
        {paid ? `A free trial, or ${priceOf(paid.monthlyPriceCents)} for more` : 'A free trial'}
      </h2>
      <div className={styles.cards}>
        {plans.map((plan) => {
          const isPaid = plan.monthlyPriceCents > 0
          return (
            <section
              key={plan.key}
              className={`bl-frame ${isPaid ? `bl-frame--solid ${styles.paid}` : ''} ${styles.card}`}
              aria-label={plan.name}
              {...seenMark(`plan_${plan.key}`)}
            >
              <h3 className={styles.name}>{plan.name}</h3>
              <p className={styles.price}>
                <span className="bl-num">{dollars(plan.monthlyPriceCents)}</span>
                {isPaid && <small> a month</small>}
              </p>
              <p className={styles.pitch}>{pitchOf(plan, bedrock)}</p>
              <Shared plan={plan} />
              <ul className={styles.points}>
                {planPoints(plan).map((point) => (
                  <li key={point}>
                    <PlanPoint plan={plan} point={point} />
                  </li>
                ))}
              </ul>
              <PlanButton plan={plan} create={create} getPlan={getPlan} />
            </section>
          )
        })}
      </div>
      <p className={`bl-body ${styles.trial}`}>{trialSaid(plans)}</p>
      <p className={`bl-body ${styles.hours}`}>
        Hours only count while the server is running.{' '}
        <Link href="/pricing" className={styles.more}>
          Full pricing
        </Link>
      </p>
    </>
  )
}

/** What a paid plan comes to for each of a group sharing it: "$5 each, shared by five friends." */
function Shared({ plan }: { plan: PublicPlan }) {
  const shared = eachOf(plan)
  if (!shared) return null
  return (
    <p className={styles.shared}>
      {shared.each} each, shared by {shared.friends} friends.
    </p>
  )
}

/** The card's button: to the plan's checkout, to a first server, or that a plan isn't for sale yet. */
function PlanButton({
  plan,
  create,
  getPlan,
}: {
  plan: PublicPlan
  create: string
  getPlan: (key: string) => string
}) {
  const isPaid = plan.monthlyPriceCents > 0
  if (isPaid && !forSale(plan))
    return (
      <span className={`bl-btn ${styles.action}`} aria-disabled="true">
        Not available yet
      </span>
    )
  return (
    <Link
      href={isPaid ? getPlan(plan.key) : create}
      className={`bl-btn ${isPaid ? 'bl-btn--lit' : ''} ${styles.action}`}
      {...(isPaid ? planMark(plan.key, 'month') : ctaMark('plans_create'))}
    >
      {isPaid ? `Get ${plan.name}` : 'Create a server'}
    </Link>
  )
}

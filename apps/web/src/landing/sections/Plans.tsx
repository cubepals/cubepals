// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The plans, from the plan table the control plane enforces, set as two cards.
 */
import type { PublicPlan } from '@blockly/contracts'
import Link from 'next/link'
import { PlanPoint, planPoints, priceOf } from '../../ui/plans'
import { Section } from '../kit'
import styles from './surface.module.css'

/** What each plan is for, as the person choosing would put it (the same words as ui/plans.tsx). */
const PITCH: Record<string, string> = {
  free: 'Plain Minecraft for a small group',
  plus: 'Modpacks, bigger groups, more play',
}

const dollars = (cents: number): string => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

/**
 * The plans, from the plan table the control plane enforces, so nothing here can promise what a
 * server won't do. The last thing a player needs; after it the page turns, and digs. With no plans
 * to show (the control plane can't be reached) the section is left out.
 */
export function Plans({
  plans,
  create,
  getPlan,
}: {
  plans: PublicPlan[]
  create: string
  /** Where a paid plan's button leads, by plan key. */
  getPlan: (key: string) => string
}) {
  const paid = plans.find((plan) => plan.monthlyPriceCents > 0)
  if (plans.length < 2) return null
  return (
    <Section
      id="price"
      name="What it costs"
      tone="paper"
      y={66}
      shot={{ az: 30, el: 54, span: 34, turn: 16 }}
      className={styles.plans}
    >
      <h2 className="bl-h2">{paid ? `Free, or ${priceOf(paid.monthlyPriceCents)} for more` : 'Free'}</h2>
      <div className={styles.cards}>
        {plans.map((plan) => {
          const isPaid = plan.monthlyPriceCents > 0
          return (
            <section
              key={plan.key}
              className={`bl-frame ${isPaid ? `bl-frame--solid ${styles.paid}` : ''} ${styles.card}`}
              aria-label={plan.name}
            >
              <h3 className={styles.name}>{plan.name}</h3>
              <p className={styles.price}>
                <span className="bl-num">{dollars(plan.monthlyPriceCents)}</span>
                {isPaid && <small> a month</small>}
              </p>
              <p className={styles.pitch}>{PITCH[plan.key] ?? ''}</p>
              <ul className={styles.points}>
                {planPoints(plan).map((point) => (
                  <li key={point}>
                    <PlanPoint plan={plan} point={point} />
                  </li>
                ))}
              </ul>
              <Link
                href={isPaid ? getPlan(plan.key) : create}
                className={`bl-btn ${isPaid ? 'bl-btn--lit' : ''} ${styles.action}`}
              >
                {isPaid ? `Get ${plan.name}` : 'Create a server'}
              </Link>
            </section>
          )
        })}
      </div>
      <p className={`bl-body ${styles.hours}`}>
        Hours only count while the server is running.{' '}
        <Link href="/pricing" className={styles.more}>
          Full pricing
        </Link>
      </p>
    </Section>
  )
}

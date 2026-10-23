// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * A plan's card on the pricing page (ui/plan-card.tsx), with its links: the month, and the year
 * paid at once where it is sold that way. Signed in, each goes to the checkout page (the
 * agreement, then paying) and back to their servers; signed out, it makes the account first, and
 * the account page carries on to the checkout page. Start free makes the account first too.
 */

import type { PublicPlan } from '@blockly/contracts'
import { checkoutHref } from '../../../lib/checkout'
import { behindSignUp, useSignedIn } from '../../../lib/viewer'
import { OfferCard } from '../../../ui/plan-card'
import { ctaMark, planMark, seenMark } from '../steps'

/** Where a paid plan's checkout is: signed out, the account is made first, and carries on there. */
const checkoutOf = (signedIn: boolean, plan: string, term: 'month' | 'year') =>
  signedIn
    ? checkoutHref({ plan, term, reason: 'pricing', next: '/servers' })
    : behindSignUp(false, `/account?get=${plan}${term === 'year' ? '&term=year' : ''}&reason=pricing`)

/** A paid plan's card on the pricing page, with its links for whoever is reading. */
export function PricingCard({
  plan,
  plans,
  trial,
  bedrock,
}: {
  plan: PublicPlan
  plans: readonly PublicPlan[]
  /** The free trial, on the plan it starts. */
  trial?: PublicPlan | undefined
  bedrock: boolean
}) {
  const signedIn = useSignedIn()
  return (
    <OfferCard
      plan={plan}
      plans={plans}
      trial={trial}
      bedrock={bedrock}
      mark={seenMark(`plan_${plan.key}`)}
      start={{ href: behindSignUp(signedIn, '/servers/new'), mark: ctaMark('pricing_create') }}
      checkout={(term) => ({ href: checkoutOf(signedIn, plan.key, term), mark: planMark(plan.key, term) })}
    />
  )
}

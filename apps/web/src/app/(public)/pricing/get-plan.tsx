// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * A plan's button on the pricing page, and the same plan for a year paid at once where it is sold
 * that way, in the card's details. Signed in, each goes to the checkout page (the agreement, then paying) and
 * back to their servers; signed out, it makes the account first, and the account page carries on
 * to the checkout page. On the plan the free trial starts, the first button starts the trial,
 * with what it is and the plan itself, quieter, beside it: the button sits as low as the other cards'.
 */

import Link from 'next/link'
import { dollars } from '../../../legal/figures'
import { checkoutHref } from '../../../lib/checkout'
import { behindSignUp, useSignedIn } from '../../../lib/viewer'
import { Button } from '../../../ui'
import { ctaMark, planMark } from '../steps'

/** Where a paid plan's checkout is: signed out, the account is made first, and carries on there. */
const checkoutOf = (signedIn: boolean, plan: string, term: 'month' | 'year') =>
  signedIn
    ? checkoutHref({ plan, term, reason: 'pricing', next: '/servers' })
    : behindSignUp(false, `/account?get=${plan}${term === 'year' ? '&term=year' : ''}&reason=pricing`)

export function GetPlan({
  plan,
  name,
  available = true,
  startsFree,
}: {
  plan: string
  name: string
  /** False for a paid plan nothing sells here yet. */
  available?: boolean
  /** On the plan the free trial starts: what the trial is, "20 hours free, no card". */
  startsFree?: string | undefined
}) {
  const signedIn = useSignedIn()
  if (!startsFree)
    return available ? (
      <Button variant="primary" href={checkoutOf(signedIn, plan, 'month')} {...planMark(plan, 'month')}>
        Get {name}
      </Button>
    ) : (
      <Button variant="outline" disabled>
        Not available yet
      </Button>
    )
  return (
    <div className="bk-row bk-wrap" style={{ gap: 'var(--space-12)', alignItems: 'center' }}>
      <Button variant="outline" href={behindSignUp(signedIn, '/servers/new')} {...ctaMark('pricing_create')}>
        Start free
      </Button>
      <div className="bk-stack" style={{ gap: 0 }}>
        <span className="type-body-sm bk-plan__each">{startsFree}</span>
        {available && (
          <Link
            href={checkoutOf(signedIn, plan, 'month')}
            className="type-body-sm bk-plan__year"
            {...planMark(plan, 'month')}
          >
            Get {name}
          </Link>
        )}
      </div>
    </div>
  )
}

/** A plan for a year paid at once, as a line in its card's details. */
export function GetYear({ plan, yearlyCents }: { plan: string; yearlyCents: number }) {
  const signedIn = useSignedIn()
  return (
    <Link href={checkoutOf(signedIn, plan, 'year')} {...planMark(plan, 'year')}>
      Or {dollars(yearlyCents)} for a year, paid once
    </Link>
  )
}

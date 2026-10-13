// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import Link from 'next/link'
import { dollars } from '../../../legal/figures'
import { checkoutHref } from '../../../lib/checkout'
import { behindSignUp, useSignedIn } from '../../../lib/viewer'
import { Button } from '../../../ui'
import { ctaMark, planMark } from '../steps'

/**
 * A plan's button on the pricing page, and under it the same plan for a year paid at once where
 * it is sold that way. Signed in, each goes to the checkout page (the agreement, then paying) and
 * back to their servers; signed out, it makes the account first, and the account page carries on
 * to the checkout page.
 */
export function GetPlan({
  plan,
  name,
  paid,
  yearlyCents = null,
}: {
  plan: string
  name: string
  paid: boolean
  yearlyCents?: number | null
}) {
  const signedIn = useSignedIn()
  if (!paid)
    return (
      <Button variant="outline" href={behindSignUp(signedIn, '/servers/new')} {...ctaMark('pricing_create')}>
        Create a server
      </Button>
    )
  const href = (term: 'month' | 'year') =>
    signedIn
      ? checkoutHref({ plan, term, reason: 'pricing', next: '/servers' })
      : behindSignUp(false, `/account?get=${plan}${term === 'year' ? '&term=year' : ''}&reason=pricing`)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <Button variant="primary" href={href('month')} {...planMark(plan, 'month')}>
        Get {name}
      </Button>
      {yearlyCents !== null && (
        <Link href={href('year')} className="type-body-sm" {...planMark(plan, 'year')}>
          Or {dollars(yearlyCents)} for a year, paid once
        </Link>
      )}
    </div>
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The button under a plan's card on the account page: Get for a larger plan (the checkout page),
 * and for a smaller one, a move at the end of the month paid for, which keeps the plan until
 * then. Not for the plan's summary or what it holds.
 */
import type { AccountOverviewView, PublicPlan } from '@blockly/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { messageOf, useTRPC } from '../../../lib/api'
import { checkoutHref } from '../../../lib/checkout'
import { dayOf } from '../../../lib/present'
import { Button, forSale, Note, priceOf } from '../../../ui'
import { planMark } from '../../(public)/steps'

/** What goes under `plan`'s card, if anything: the person's own plan and one not for sale have none. */
export function planAction(plan: PublicPlan, overview: AccountOverviewView, sells: boolean): ReactNode {
  const { billed } = overview.plan
  if (!sells || !forSale(plan) || plan.monthlyPriceCents === 0 || plan.key === overview.plan.key)
    return undefined
  if (plan.monthlyPriceCents > overview.entitlements.monthlyPriceCents)
    return (
      <Button
        variant="primary"
        href={checkoutHref({ plan: plan.key, reason: 'account' })}
        {...planMark(plan.key, 'month')}
      >
        Get {plan.name}
      </Button>
    )
  const paying = billed?.status === 'active' && billed.planKey === overview.plan.key
  if (!paying || billed.cancelAtPeriodEnd || billed.periodEnd === null || billed.movesTo) return undefined
  return <MoveDown plan={plan} planNow={overview.plan.key} from={billed.periodEnd} />
}

/**
 * A move to a smaller plan from the day the month paid for ends: the plan now stays until then.
 * The first press asks what the smaller plan would charge (`billing.offer`), and shows it; the
 * second moves at that price.
 */
function MoveDown({ plan, planNow, from }: { plan: PublicPlan; planNow: string; from: string }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const asked = useMutation(trpc.billing.offer.mutationOptions())
  const move = useMutation(
    trpc.billing.moveTo.mutationOptions({
      onSuccess: () => queries.invalidateQueries({ queryKey: trpc.account.overview.queryKey() }),
      // A move refused (the price changed since it was shown) asks again, so the button carries
      // the price the page now shows, as the checkout page does.
      onError: () => asked.mutate({ plan: plan.key }),
    }),
  )
  const now = `${planNow[0]?.toUpperCase() ?? ''}${planNow.slice(1)}`
  const offer = asked.data
  if (offer === undefined)
    return (
      <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <Button
          variant="outline"
          busy={asked.isPending ? 'Checking' : undefined}
          onClick={() => asked.mutate({ plan: plan.key })}
        >
          {plan.name} from {dayOf(from)}
        </Button>
        <p className="type-body-sm">{now} stays until then. Your worlds are kept.</p>
        {asked.isError && <Note tone="danger">{messageOf(asked.error)}</Note>}
      </div>
    )
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <p className="type-body-sm">
        {plan.name} is {priceOf(offer.priceCents)}
        {offer.includedUnits === null ? '' : `, with ${offer.includedUnits} hours of play`}, from{' '}
        {dayOf(from)}. {now} stays until then. Your worlds are kept.
      </p>
      <Button
        variant="outline"
        busy={move.isPending ? 'Moving' : undefined}
        onClick={() => move.mutate({ plan: plan.key, priceCents: offer.priceCents })}
      >
        Move to {plan.name}
      </Button>
      {move.isError && <Note tone="danger">{messageOf(move.error)}</Note>}
    </div>
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { backAtMidnight } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../../lib/api'
import { useNow } from '../../lib/hooks'
import { forSale, Note } from '../../ui'
import { PlusOffer } from './plus-offer'

/**
 * Today's play is used up: when it is back, counting down, in the words a refused start and the
 * server list use too, with the plan that plays by the month beside it. The server page and the
 * account page both say it.
 */
export function OutForToday({ hours, backAt, next }: { hours: number; backAt: string; next?: string }) {
  const trpc = useTRPC()
  const now = useNow(30_000)
  const overview = useQuery(trpc.account.overview.queryOptions())
  const listed = useQuery(trpc.billing.plans.queryOptions())
  const monthly = overview.data?.plans.find(
    (p) =>
      p.entitlements.dailyUnits === null &&
      p.entitlements.includedUnits !== null &&
      listed.data?.some((plan) => plan.key === p.key && forSale(plan)),
  )
  return (
    <>
      <Note tone="info">
        You’ve played today’s {hours} hour{hours === 1 ? '' : 's'}.{' '}
        {backAtMidnight(new Date(now), new Date(backAt))}.
      </Note>
      {monthly && (
        <PlusOffer
          why={`${monthly.key.charAt(0).toUpperCase()}${monthly.key.slice(1)} has ${monthly.entitlements.includedUnits} hours a month, to play whenever you like.`}
          plan={monthly.key}
          reason="hours"
          {...(next === undefined ? {} : { next })}
        />
      )}
    </>
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../../lib/api'
import { forSale, Note } from '../../ui'
import { PlusOffer } from './plus-offer'

/**
 * The plan's hours in all are played (Free's 20): they don't come back, the worlds are kept and
 * download as before, and the plan that plays by the month starts them again. The server page and
 * the account page both say it.
 */
export function FreeHoursUsed({ hours, next }: { hours: number; next?: string }) {
  const trpc = useTRPC()
  const overview = useQuery(trpc.account.overview.queryOptions())
  const listed = useQuery(trpc.billing.plans.queryOptions())
  // The plan that plays by the month and is for sale here: nothing is offered that nothing sells.
  const monthly = overview.data?.plans.find(
    (p) =>
      p.entitlements.totalUnits === null &&
      p.entitlements.includedUnits !== null &&
      listed.data?.some((plan) => plan.key === p.key && forSale(plan)),
  )
  return (
    <>
      <Note tone="info">
        You’ve played the {hours} hours of your free trial. Nothing is charged. Your worlds are kept, and you
        can still download them.
      </Note>
      {monthly && (
        <PlusOffer
          why={`${monthly.key.charAt(0).toUpperCase()}${monthly.key.slice(1)} starts them again, with ${listed.data?.find((plan) => plan.key === monthly.key)?.includedHours ?? monthly.entitlements.includedUnits} hours a month.`}
          plan={monthly.key}
          reason="hours"
          {...(next === undefined ? {} : { next })}
        />
      )}
    </>
  )
}

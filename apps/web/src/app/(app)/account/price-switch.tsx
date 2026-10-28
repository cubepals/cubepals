// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Where the plan the person pays for is sold for less now, with more hours, than their
 * subscription pays: the price and hours, and a way to take them on the same subscription now.
 * Nothing otherwise. Not for moving to another plan (`plan-action.tsx`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../lib/api'
import { Button, Note, priceOf } from '../../../ui'

export function PriceSwitch() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const offer = useQuery(trpc.billing.switchable.queryOptions())
  const take = useMutation(
    trpc.billing.switchPrice.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queries.invalidateQueries({ queryKey: trpc.account.overview.queryKey() }),
          queries.invalidateQueries({ queryKey: trpc.billing.switchable.queryKey() }),
        ]),
    }),
  )
  const now = offer.data
  if (!now) return null
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      <p className="type-body-sm">
        Your plan is {priceOf(now.priceCents)}
        {now.includedUnits === null ? '' : ` with ${now.includedUnits} hours of play`} for anyone who
        subscribes today. You can have that price and those hours now, on the same subscription.
      </p>
      <Button
        variant="outline"
        busy={take.isPending ? 'Switching' : undefined}
        onClick={() => take.mutate({ priceCents: now.priceCents })}
      >
        Switch to {priceOf(now.priceCents)}
      </Button>
      {take.isError && <Note tone="danger">{messageOf(take.error)}</Note>}
    </div>
  )
}

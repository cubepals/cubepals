// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../../../../lib/api'

/**
 * Whether the plan lets the account make another server, as creating would answer: what the page
 * says when it doesn't, its code, and the plan that has more. The page shows it; `steps.ts`
 * reports it, by the same rule.
 */
export function usePlanLimit(replace: string | null) {
  const trpc = useTRPC()
  const overview = useQuery(trpc.account.overview.queryOptions())
  const creating = overview.data?.features.find((f) => f.feature === 'create_server')
  // The server being replaced makes way first, so the plan's limit doesn't stand in the way.
  const atLimit = replace === null && creating?.available === false ? (creating.message ?? null) : null
  // A plan edge the person met here, where another plan would run it: a paid plan's own words,
  // said where the choice was made, and a way on without it.
  const limitCode = creating?.available === false ? creating.code : undefined
  const moreServers = overview.data?.plans.find(
    (p) => p.entitlements.maxServers > (overview.data?.entitlements.maxServers ?? 0),
  )
  return { atLimit, limitCode, moreServers }
}

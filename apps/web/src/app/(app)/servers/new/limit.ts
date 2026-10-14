// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { AccountOverviewView } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '../../../../lib/api'

/** What the page says while there is no room, before anyone has asked for anything. */
const FULL_NOW = 'Cubepals is full right now. Try again in a few minutes.'

const creatingIn = (overview: AccountOverviewView | undefined) =>
  overview?.features.find((f) => f.feature === 'create_server')

type Creating = AccountOverviewView['features'][number]

/**
 * What the page says stands in the way of a new server, before anything is asked; null when
 * nothing does. The server being replaced makes way first, so the plan's limit doesn't stand in
 * the way; with no room, nothing can be made in its place either.
 */
export function atLimitOf(creating: Creating | undefined, replace: string | null): string | null {
  if (creating?.available !== false) return null
  if (creating.code === 'platform_full') return FULL_NOW
  return replace === null ? (creating.message ?? null) : null
}

/**
 * Whether the plan lets the account make another server, as creating would answer: what the page
 * says when it doesn't, its code, and the plan that has more. The page shows it; `steps.ts`
 * reports it, by the same rule. While Cubepals is full it asks again every minute, so the page
 * opens by itself once there is room.
 */
export function usePlanLimit(replace: string | null) {
  const trpc = useTRPC()
  const overview = useQuery({
    ...trpc.account.overview.queryOptions(),
    refetchInterval: (query) => (creatingIn(query.state.data)?.code === 'platform_full' ? MINUTE_MS : false),
  })
  const creating = creatingIn(overview.data)
  const atLimit = atLimitOf(creating, replace)
  // A plan edge the person met here, where another plan would run it: a paid plan's own words,
  // said where the choice was made, and a way on without it.
  const limitCode = creating?.available === false ? creating.code : undefined
  const moreServers = overview.data?.plans.find(
    (p) => p.entitlements.maxServers > (overview.data?.entitlements.maxServers ?? 0),
  )
  return { atLimit, limitCode, moreServers }
}

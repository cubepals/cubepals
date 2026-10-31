// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server resting for its owner's free trial, at the top of its page: what its owner, signed in,
 * and anyone else reads there, with the plans the page was given.
 */
import { describe, expect, test } from 'bun:test'
import type { PublicPlan, RestingView } from '@blockly/contracts'
import type { AppRouter } from '@blockly/control/router'
import { dehydrate, QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiProvider } from '../../lib/api'
import { keepPlayingHref } from '../../lib/keep-playing'
import { Resting } from './resting'

const trial = {
  key: 'free',
  name: 'Free trial',
  available: true,
  monthlyPriceCents: 0,
  includedHours: 20,
  per: 'once',
  totalHours: 20,
} as PublicPlan
const monthly = {
  ...trial,
  key: 'month',
  name: 'Month',
  monthlyPriceCents: 1200,
  includedHours: 50,
  per: 'month',
  totalHours: null,
} as PublicPlan

/** The page as drawn, with `plans` as the control plane listed them, or none answered yet. */
function drawn(view: RestingView, plans?: PublicPlan[]): string {
  const queryClient = new QueryClient()
  const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: 'http://localhost/api/trpc' })] })
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient })
  if (plans) queryClient.setQueryData(trpc.billing.plans.queryKey(), plans)
  return renderToStaticMarkup(
    // biome-ignore lint/correctness/noChildrenProp: with no JSX in a test, its props are where the provider's children are typed
    createElement(ApiProvider, { data: dehydrate(queryClient), children: createElement(Resting, { view }) }),
  )
}

const yours: RestingView = { name: 'Sunset Valley', yours: true, serverId: 'srv_1' }

describe('a server resting for its free trial, on its page', () => {
  test('its owner gets one way on, straight to checkout for the plan by the month, with their world kept', () => {
    const page = drawn(yours, [trial, monthly])
    expect(page).toContain('Sunset Valley is resting')
    expect(page).toContain('Your free trial is used up. Your world is kept, and nothing is charged.')
    expect(page).toContain('Month starts it again: $12 a month, with 50 hours of play every month.')
    expect(page).toContain(`href="${keepPlayingHref('month', 'srv_1').replaceAll('&', '&amp;')}"`)
    expect(page).toContain('>Keep playing<')
    expect(page).toContain('data-cta="keep_playing"')
    expect(page).toContain('data-seen="resting_owner"')
  })

  test('where no plan by the month is for sale, its owner is sent to their server instead', () => {
    for (const plans of [[trial], undefined]) {
      const page = drawn(yours, plans)
      expect(page).toContain('href="/servers/srv_1"')
      expect(page).toContain('>Open your server<')
      expect(page).not.toContain('Keep playing')
      expect(page).not.toContain('starts it again')
    }
  })

  test('anyone else reads whose server it is, that its world is kept, and that its owner can start it', () => {
    const page = drawn({ name: 'Sunset Valley', yours: false }, [trial, monthly])
    expect(page).toContain('Sunset Valley is resting')
    expect(page).toContain('Its owner’s free trial is used up, so it can’t start for now. Its world is kept.')
    expect(page).toContain('they can start it again from their Cubepals account')
    expect(page).toContain('data-seen="resting_friend"')
    // Nothing to buy, and nothing said as if it were theirs.
    expect(page).not.toContain('checkout')
    expect(page).not.toMatch(/Your /)
  })
})

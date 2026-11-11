// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The account page as a subscriber reads it: their own plan's card and the plan section say the
 * price and hours their subscription holds, by the month or by the year, while the other cards say
 * what a new subscriber is offered now. Their own plan's card is the dark one, and a larger plan is
 * got with the app's own button.
 */
import { describe, expect, test } from 'bun:test'
import type { AccountOverviewView, EntitlementsView, MeView, PublicPlan } from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'
import type { AppRouter } from '@blockly/control/router'
import { dehydrate, QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiProvider } from '../../../lib/api'
import AccountPage from './page'

const free = {
  key: 'free',
  name: 'Free trial',
  available: true,
  monthlyPriceCents: 0,
  yearlyPriceCents: null,
  includedHours: 20,
  per: 'once',
  extraHourCents: null,
  totalHours: 20,
  sleepsAfterMinutes: 10,
  maxServers: 1,
  maxPlayers: 5,
  sizes: [{ gb: 3, maxPlayers: 5, hoursAnHour: 1 }],
  mods: false,
  datapacks: false,
  downloads: 'daily',
  sessionsKept: 3,
  restsAfterDays: 14,
  deletedAfterDays: 365,
} satisfies PublicPlan
const core: PublicPlan = {
  ...free,
  key: 'core',
  name: 'Core',
  monthlyPriceCents: 999,
  includedHours: 40,
  per: 'month',
  extraHourCents: 25,
  totalHours: null,
  deletedAfterDays: null,
}
/** Plus as `billing.plans` answers it: what a new subscriber is offered now. */
const plus: PublicPlan = {
  ...core,
  key: 'plus',
  name: 'Plus',
  monthlyPriceCents: 2500,
  yearlyPriceCents: 25000,
  includedHours: 120,
  maxServers: 3,
  maxPlayers: 40,
  mods: true,
  datapacks: true,
}

/** Plus as the subscriber's own subscription holds it, which isn't what it is offered at now. */
const held: EntitlementsView = {
  plan: 'plus',
  monthlyPriceCents: 1234,
  yearlyPriceCents: 25000,
  maxServers: 3,
  maxRunning: 1,
  allowedMemoryTiers: ['3g'],
  sizeLabels: ['3 GB · up to 5 players'],
  includedUnits: 77,
  carryUnits: null,
  totalUnits: null,
  mayBuyMore: false,
  mostExtraUnits: null,
  mayChooseAfkKick: true,
  mayTurnOffOnlineMode: true,
  idleShutdownAfterMinutes: 15,
  playerIdleKickMinutes: 15,
  maxSessionMinutes: null,
  allowedLoaders: ['vanilla', 'paper'],
  mayUseMods: true,
  mayUseDatapacks: true,
  settingCaps: null,
  backupPolicy: { snapshotsKept: 14, archiveEnabled: true, archiveRetentionDays: 30, downloadsPerDay: null },
  storeAfterIdleDays: 30,
  deleteAfterIdleDays: null,
  mayListPublicly: true,
  mayUploadCustomMods: true,
  trashRetentionDays: 30,
}

const me: MeView = {
  userId: 'user_1',
  name: 'Alex',
  email: 'alex@example.com',
  admin: false,
  standing: { status: 'active', reason: null, plan: 'plus' },
  timeZone: 'UTC',
}

const day = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()
type Billed = NonNullable<AccountOverviewView['plan']['billed']>
const byTheMonth: Billed = {
  status: 'active',
  periodEnd: day(20),
  cancelAtPeriodEnd: false,
  planKey: 'plus',
  pastDueUntil: null,
  endedFor: null,
  movesTo: null,
}
const aYear = (startsIn: number) => ({
  planKey: 'plus',
  startsAt: day(startsIn),
  endsAt: day(startsIn + 365),
  renewed: false,
})

/** A Plus account's overview, paid for by `plan`'s subscription or year. */
const overviewOf = (plan: Pick<AccountOverviewView['plan'], 'billed' | 'year'>): AccountOverviewView => ({
  standing: { status: 'active', reason: null },
  plan: { key: 'plus', gifted: null, giftNext: null, ...plan },
  entitlements: held,
  settings: { afkKickMinutes: null },
  usage: {
    servers: 1,
    running: 0,
    today: null,
    total: null,
    unitsThisMonth: 3,
    hoursThisMonth: 3,
    carriedUnits: 0,
    monthBegan: day(-2),
    timeZone: 'UTC',
    nextTimeZone: null,
    extraUnitsAllowed: 0,
    unitCents: 25,
    extra: {
      may: false,
      why: null,
      ceiling: 0,
      nextCeiling: null,
      choices: [],
      countedUnits: 0,
      reportedUnits: 0,
      owedCents: 0,
      settleCents: 0,
    },
  },
  features: [{ feature: 'billing', available: true }],
  plans: [],
})

const router: AppRouterInstance = {
  bfcacheId: '',
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
}

/** The account page as drawn for `overview`, with the plans `billing.plans` answers. */
function drawn(overview: AccountOverviewView): string {
  const queryClient = new QueryClient()
  const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: 'http://localhost/api/trpc' })] })
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient })
  queryClient.setQueryData(trpc.account.me.queryKey(), me)
  queryClient.setQueryData(trpc.account.overview.queryKey(), overview)
  queryClient.setQueryData(trpc.billing.plans.queryKey(), [free, core, plus])
  const data = dehydrate(queryClient)
  // biome-ignore lint/correctness/noChildrenProp: with no JSX in a test, its props are where the provider's children are typed
  const page = createElement(ApiProvider, { data, children: createElement(AccountPage) })
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(
        SearchParamsContext.Provider,
        { value: new URLSearchParams() },
        createElement(PathnameContext.Provider, { value: '/account' }, page),
      ),
    ),
  )
}

/** One plan's card on the page, from its opening tag. */
const cardOf = (html: string, name: string) =>
  html.slice(html.lastIndexOf('<section', html.indexOf(`aria-label="${name}"`))).split('</section>')[0] ?? ''

/** A card's price, large, as the app's cards write it. */
const priceIn = (card: string) => card.match(/class="type-display-md bk-num">([^<]*)</)?.[1]

/** Whether a card is the dark one. */
const dark = (card: string) => /^<section [^>]*data-paid/.test(card)

/** A Core account by the month, otherwise as `overviewOf` has it. */
const onCore = (): AccountOverviewView => {
  const overview = overviewOf({ billed: { ...byTheMonth, planKey: 'core' }, year: null })
  return { ...overview, plan: { ...overview.plan, key: 'core' }, entitlements: { ...held, plan: 'core' } }
}
/** An account still on the free trial, otherwise as `overviewOf` has it. */
const onTrial = (): AccountOverviewView => {
  const overview = overviewOf({ billed: null, year: null })
  return { ...overview, plan: { ...overview.plan, key: 'free' }, entitlements: { ...held, plan: 'free' } }
}

describe('a subscriber’s own plan on the account page', () => {
  test('its card says the price and hours they hold, and the other cards what is offered now', () => {
    const html = drawn(overviewOf({ billed: byTheMonth, year: null }))
    const yours = cardOf(html, 'Plus')
    expect(yours).toContain('Yours')
    expect(priceIn(yours)).toBe('$12.34')
    expect(yours).toContain('77 hours of play each month')
    expect(yours).not.toContain('120 hours')
    const other = cardOf(html, 'Core')
    expect(other).not.toContain('Yours')
    expect(priceIn(other)).toBe('$9.99')
    expect(other).toContain('40 hours of play each month')
  })

  test('their own plan is the dark card, whichever it is, and the others are light', () => {
    const plus = drawn(overviewOf({ billed: byTheMonth, year: null }))
    expect([dark(cardOf(plus, 'Plus')), dark(cardOf(plus, 'Core'))]).toEqual([true, false])
    const core = drawn(onCore())
    expect([dark(cardOf(core, 'Core')), dark(cardOf(core, 'Plus'))]).toEqual([true, false])
    // On the free trial, the plan it starts is theirs.
    const trial = drawn(onTrial())
    expect(cardOf(trial, 'Core')).toContain('Your free trial')
    expect([dark(cardOf(trial, 'Core')), dark(cardOf(trial, 'Plus'))]).toEqual([true, false])
  })

  test('a larger plan is got with the app’s own button, by the month at checkout', () => {
    const plus = cardOf(drawn(onCore()), 'Plus')
    expect(plus).toMatch(
      /<a class="bk-btn bk-btn--primary[^"]*"[^>]*href="\/checkout\?plan=plus&amp;[^"]*">Get Plus</,
    )
    expect(plus).not.toContain('bl-btn')
    expect(plus).not.toContain('term=year')
  })

  test('the plan section says the subscription by the month', () => {
    const said = 'Your current subscription: $12.34 a month with 77 hours of play each month.'
    expect(drawn(overviewOf({ billed: byTheMonth, year: null }))).toContain(said)
    // A year waiting for the month already paid for: the month is what they hold until then.
    const waiting = { ...byTheMonth, cancelAtPeriodEnd: true }
    expect(drawn(overviewOf({ billed: waiting, year: aYear(20) }))).toContain(said)
  })

  test('the plan section says the subscription by the year', () => {
    const html = drawn(overviewOf({ billed: null, year: aYear(-30) }))
    expect(html).toContain('Your current subscription: $250.00 a year with 77 hours of play each month.')
    expect(html).not.toContain('a month with 77 hours')
  })

  test('nothing is said of a subscription that has ended', () => {
    const ended = { ...byTheMonth, status: 'ended' }
    expect(drawn(overviewOf({ billed: ended, year: null }))).not.toContain('Your current subscription')
  })
})

describe('another plan’s figures where the month is used up', () => {
  /**
   * A Core account by the month with its hours played and extra play allowed, where the plan table
   * says Plus differs from what `billing.plans` offers now (`plus`): made-up figures.
   */
  const usedUp = (): AccountOverviewView => {
    const overview = onCore()
    const table = {
      ...held,
      plan: 'plus',
      monthlyPriceCents: plus.monthlyPriceCents + 500,
      includedUnits: 150,
    }
    return {
      ...overview,
      entitlements: { ...overview.entitlements, mayBuyMore: true },
      usage: {
        ...overview.usage,
        unitsThisMonth: held.includedUnits ?? 0,
        hoursThisMonth: held.includedUnits ?? 0,
        extra: { ...overview.usage.extra, may: true, ceiling: 50, choices: [0, 10] },
      },
      plans: [
        { key: 'core', entitlements: overview.entitlements },
        { key: 'plus', entitlements: table },
      ],
    }
  }

  test('states the larger plan’s hours and where it costs less as it is offered now', () => {
    const overview = usedUp()
    const html = drawn(overview)
    const past = (cents: number) => Math.floor((cents - held.monthlyPriceCents) / overview.usage.unitCents)
    const table = overview.plans[1]?.entitlements
    if (table === undefined) throw new Error('the overview lists Plus')
    expect(html).toContain(`past ${past(plus.monthlyPriceCents)} extra hours a month, Plus costs less.`)
    expect(html).not.toContain(`past ${past(table.monthlyPriceCents)} extra hours`)
    expect(html).toContain(`Plus has ${plus.includedHours} hours a month.`)
    expect(html).not.toContain(`${table.includedUnits} hours`)
  })
})

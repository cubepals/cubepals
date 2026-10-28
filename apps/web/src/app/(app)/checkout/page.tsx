// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The step before a paid plan's payment page: what the plan is and costs, VAT included, by the
 * month or for a year paid at once (which never renews, and is also how a year is renewed), and
 * the two things the person agrees to before it starts (the Terms, and that it starts now inside
 * the 14 days they could cancel in: a full refund below 30 hours played, the unplayed part past
 * it). The API refuses a checkout without them, and the audit log keeps them with it. A month's
 * price and hours are the ones the control plane holds for this page when it opens
 * (`billing.offer`), the price the checkout then charges. Then the payment page, which is Polar's.
 */

import type { AccountOverviewView, EntitlementsView, PlanOfferView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { FULL_REFUND_UNDER_HOURS } from '../../../legal/figures'
import { consentFor, UNCONSENTED } from '../../../lib/agreement'
import { messageOf, useTRPC } from '../../../lib/api'
import { type CheckoutAsk, checkoutHref, checkoutOf } from '../../../lib/checkout'
import { checkoutContinued, checkoutOpened } from '../../../lib/paying'
import { Button, Card, Checkbox, LoadFailed, Note, PlayHours, Skeleton } from '../../../ui'

export default function CheckoutPage() {
  return (
    <Suspense fallback={<Skeleton width={240} height={36} />}>
      <Checkout />
    </Suspense>
  )
}

function Checkout() {
  const params = useSearchParams()
  const ask = checkoutOf(params)
  const trpc = useTRPC()
  const overview = useQuery(trpc.account.overview.queryOptions())
  const listed = useQuery(trpc.billing.plans.queryOptions())
  if (ask === null)
    return (
      <Note tone="info">
        Choose a plan on the <Link href="/pricing">Pricing</Link> page.
      </Note>
    )
  if (overview.isPending || listed.isPending) return <Skeleton width={240} height={36} />
  if (overview.isError)
    return <LoadFailed error={messageOf(overview.error)} onRetry={() => overview.refetch()} />
  const billing = overview.data.features.find((f) => f.feature === 'billing')
  const offered = overview.data.plans.find((p) => p.key === ask.plan)?.entitlements
  const name = `${ask.plan[0]?.toUpperCase() ?? ''}${ask.plan.slice(1)}`
  const year = ask.term === 'year'
  const plan = overview.data.plan
  if (year && plan.year?.renewed)
    return (
      <Note tone="info">
        Your next year of {name} is paid for already. <Link href="/account">Your account</Link> says when it
        ends.
      </Note>
    )
  // A plan nothing sells here yet: said, with where it will be, never an error.
  if (listed.data?.find((p) => p.key === ask.plan)?.available === false)
    return (
      <Note tone="info">
        {name} isn’t available yet. <Link href="/pricing">Pricing</Link> has the plans you can get now.
      </Note>
    )
  if (!year && plan.key === ask.plan)
    return (
      <Note tone="info">
        You’re on {name} already. <Link href="/account">Your account</Link> says when it renews.
      </Note>
    )
  if (
    !billing?.available ||
    offered === undefined ||
    offered.monthlyPriceCents === 0 ||
    (year && offered.yearlyPriceCents === null)
  )
    return (
      <Note tone="info">
        {billing?.available === false ? billing.message : `There is no ${name} plan to buy.`}
      </Note>
    )
  return <Offer ask={ask} name={name} offered={offered} startsAt={startsAt(plan, ask.plan)} />
}

/**
 * When a year bought now would start: when the time already paid for on this plan ends (a year,
 * or a month that then doesn't renew), or null for straight away.
 */
function startsAt(plan: AccountOverviewView['plan'], key: string): string | null {
  const ends = plan.year?.endsAt ?? (plan.billed?.planKey === key ? plan.billed.periodEnd : null)
  return plan.key === key && ends !== null && new Date(ends).getTime() > Date.now() ? ends : null
}

/** The plan, the two boxes and the way on to paying, once there is a plan to buy. */
function Offer({
  ask,
  name,
  offered,
  startsAt,
}: {
  ask: CheckoutAsk
  name: string
  offered: EntitlementsView
  startsAt: string | null
}) {
  const trpc = useTRPC()
  const { plan, term = 'month' } = ask
  const { month, ask: holdPrice } = useHeldMonth(ask, offered)
  const checkout = useMutation(
    trpc.billing.checkout.mutationOptions({
      onSuccess: ({ url }) => window.location.assign(url),
      // The price may have changed since the page opened: the page asks again, and shows it.
      onError: holdPrice,
    }),
  )
  const [terms, setTerms] = useState(false)
  const [startNow, setStartNow] = useState(false)
  const [unticked, setUnticked] = useState(false)
  const consent = consentFor(terms, startNow)
  const early = month?.early ?? false
  const pay = () => {
    if (consent === null) {
      setUnticked(true)
      return
    }
    checkoutContinued(plan, term, early)
    checkout.mutate({
      plan: ask.plan,
      term: ask.term ?? 'month',
      reason: ask.reason,
      consent,
      ...(ask.next ? { next: ask.next } : {}),
      ...(month === null ? {} : { priceCents: month.priceCents }),
    })
  }
  if (term === 'month' && month === null) return <Skeleton width={240} height={36} />
  const yearly = ask.term === 'year' ? offered.yearlyPriceCents : null
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-24)', maxWidth: 'var(--width-form)' }}>
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          {yearly === null
            ? `Get ${name}`
            : startsAt === null
              ? `Get a year of ${name}`
              : `Renew ${name} for a year`}
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          Two boxes to tick, then you pay on Polar’s secure page and come straight back.
        </p>
      </header>
      <Price ask={ask} name={name} offered={offered} month={month} startsAt={startsAt} />
      <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
        <Checkbox checked={terms} onChange={setTerms} invalid={unticked && !terms}>
          I agree to the{' '}
          <Link href="/legal/terms" target="_blank">
            Terms of Service
          </Link>{' '}
          and the{' '}
          <Link href="/legal/refunds" target="_blank">
            Refunds and cancellation
          </Link>{' '}
          policy.
        </Checkbox>
        <Checkbox
          checked={startNow}
          onChange={setStartNow}
          invalid={unticked && !startNow}
          error={unticked && consent === null ? UNCONSENTED : null}
        >
          Start {name} straight away. I understand that if I cancel within 14 days of buying, I get a full
          refund only if I’ve played less than {FULL_REFUND_UNDER_HOURS} hours; otherwise I pay for the hours
          I played.
        </Checkbox>
      </div>
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        Polar, our merchant of record, takes the payment and shows the final price, with any VAT, before you
        pay.{' '}
        {yearly === null
          ? 'You can cancel any time from your account under Manage billing.'
          : 'After the first 14 days, stopping early gets back each whole month left.'}
      </p>
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
        <Button variant="primary" size="lg" disabled={checkout.isPending} onClick={pay}>
          {checkout.isPending ? 'Opening the payment page…' : 'Continue to payment'}
        </Button>
        <Button variant="ghost" size="lg" href={ask.next ?? '/account'}>
          Not now
        </Button>
      </div>
      {checkout.isError && <Note tone="danger">{messageOf(checkout.error)}</Note>}
    </div>
  )
}

/**
 * What is bought and what it costs: a month that renews, or a year paid once, starting now or
 * when the time already paid for ends. Bought new, a link switches to the other.
 */
function Price({
  ask,
  name,
  offered,
  month,
  startsAt,
}: {
  ask: CheckoutAsk
  name: string
  offered: EntitlementsView
  /** The month as the page holds it; null for a year. */
  month: PlanOfferView | null
  startsAt: string | null
}) {
  const yearly = ask.term === 'year' ? offered.yearlyPriceCents : null
  const hours = month?.includedUnits ?? offered.includedUnits
  const monthly = month?.priceCents ?? offered.monthlyPriceCents
  const included = (
    <>
      {hours !== null && (
        <PlayHours hours={hours} priceCents={monthly}>
          {hours} hours of play
        </PlayHours>
      )}{' '}
      each month, up to {offered.maxServers} servers.
    </>
  )
  const starts =
    startsAt === null
      ? 'It starts as soon as you pay.'
      : `It starts on ${new Date(startsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}, when the time you’ve paid for ends.`
  return (
    <>
      {yearly === null ? (
        <Card
          flat
          title={`${name}: ${dollars(monthly)} a month`}
          description={<>VAT included where it applies. Renews every month until you cancel. {included}</>}
        />
      ) : (
        <Card
          flat
          title={`${name}: ${dollars(yearly)} for a year`}
          description={
            <>
              VAT included where it applies. Paid once, and it doesn’t renew on its own: we email you before
              it ends. {starts} {included}
            </>
          }
        />
      )}
      {offered.yearlyPriceCents !== null && startsAt === null && (
        <p className="type-body-sm">
          <Link href={checkoutHref({ ...ask, term: yearly === null ? 'year' : 'month' })}>
            {yearly === null
              ? `Or pay ${dollars(offered.yearlyPriceCents)} for a year`
              : `Or pay ${dollars(offered.monthlyPriceCents)} a month`}
          </Link>
        </p>
      )}
    </>
  )
}

/**
 * The month as the page holds it (`billing.offer`), asked for when the page opens and again by
 * `ask`; null while it is asked for, and always for a year, whose price is the plan's own. One the
 * page couldn't be told is the plan's own. Says the checkout opened once there is a price to show.
 */
function useHeldMonth(ask: CheckoutAsk, offered: EntitlementsView) {
  const trpc = useTRPC()
  const { plan, term = 'month', reason } = ask
  const held = useMutation(trpc.billing.offer.mutationOptions())
  const holdPrice = held.mutate
  const askAgain = useCallback(() => {
    if (term === 'month') holdPrice({ plan })
  }, [plan, term, holdPrice])
  useEffect(askAgain, [askAgain])
  const month = term === 'month' ? (held.data ?? (held.isError ? ownOffer(plan, offered) : null)) : null
  const early = month?.early ?? false
  const shown = term === 'year' || month !== null
  useEffect(() => {
    if (shown) checkoutOpened(plan, term, reason, early)
  }, [plan, term, reason, early, shown])
  return { month, ask: askAgain }
}

/** A month at the plan's own price and hours, where the page couldn't be told what it is held at. */
const ownOffer = (plan: string, offered: EntitlementsView): PlanOfferView => ({
  plan,
  priceCents: offered.monthlyPriceCents,
  includedUnits: offered.includedUnits,
  mostExtraUnits: offered.mostExtraUnits,
  early: false,
})

/** A price as it is said: "$15", or "$4.50" where there are cents. */
const dollars = (cents: number) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

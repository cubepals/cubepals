'use client'

/**
 * The step before a paid plan's payment page: what the plan is and costs, VAT included, and the
 * two things the person agrees to before it starts (the Terms, and that it starts now inside the
 * 14 days they could cancel in: a full refund below 30 hours played, the unplayed part past it). The API refuses a
 * checkout without them, and the audit log keeps them with it. Then the payment page, which is
 * Polar's.
 */

import type { EntitlementsView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { FULL_REFUND_UNDER_HOURS } from '../../../legal/figures'
import { consentFor, UNCONSENTED } from '../../../lib/agreement'
import { messageOf, useTRPC } from '../../../lib/api'
import { type CheckoutAsk, checkoutOf } from '../../../lib/checkout'
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
  if (ask === null)
    return (
      <Note tone="info">
        Choose a plan on the <Link href="/pricing">Pricing</Link> page.
      </Note>
    )
  if (overview.isPending) return <Skeleton width={240} height={36} />
  if (overview.isError)
    return <LoadFailed error={messageOf(overview.error)} onRetry={() => overview.refetch()} />
  const billing = overview.data.features.find((f) => f.feature === 'billing')
  const offered = overview.data.plans.find((p) => p.key === ask.plan)?.entitlements
  const name = `${ask.plan[0]?.toUpperCase() ?? ''}${ask.plan.slice(1)}`
  if (overview.data.plan.key === ask.plan)
    return (
      <Note tone="info">
        You’re on {name} already. <Link href="/account">Your account</Link> says when it renews.
      </Note>
    )
  if (!billing?.available || offered === undefined || offered.monthlyPriceCents === 0)
    return (
      <Note tone="info">
        {billing?.available === false ? billing.message : `There is no ${name} plan to buy.`}
      </Note>
    )
  return <Offer ask={ask} name={name} offered={offered} />
}

/** The plan, the two boxes and the way on to paying, once there is a plan to buy. */
function Offer({ ask, name, offered }: { ask: CheckoutAsk; name: string; offered: EntitlementsView }) {
  const trpc = useTRPC()
  const checkout = useMutation(
    trpc.billing.checkout.mutationOptions({ onSuccess: ({ url }) => window.location.assign(url) }),
  )
  const [terms, setTerms] = useState(false)
  const [startNow, setStartNow] = useState(false)
  const [unticked, setUnticked] = useState(false)
  const consent = consentFor(terms, startNow)
  const pay = () => {
    if (consent === null) {
      setUnticked(true)
      return
    }
    checkout.mutate({ plan: ask.plan, reason: ask.reason, consent, ...(ask.next ? { next: ask.next } : {}) })
  }
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-24)', maxWidth: 'var(--width-form)' }}>
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Get {name}
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          Two boxes to tick, then you pay on Polar’s secure page and come straight back.
        </p>
      </header>
      <Card
        flat
        title={`${name}: ${dollars(offered.monthlyPriceCents)} a month`}
        description={
          <>
            VAT included where it applies. Renews every month until you cancel.{' '}
            {offered.includedUnits !== null && (
              <PlayHours hours={offered.includedUnits}>{offered.includedUnits} hours of play</PlayHours>
            )}{' '}
            each month, up to {offered.maxServers} servers.
          </>
        }
      />
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
        pay. You can cancel any time from your account under Manage billing.
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

/** A price as it is said: "$15", or "$4.50" where there are cents. */
const dollars = (cents: number) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

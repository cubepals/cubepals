// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { UpgradeReason } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { useTRPC } from '../../lib/api'
import { checkoutHref } from '../../lib/checkout'
import { upgradeDeclined, upgradePressed, upgradeShown } from '../../lib/paying'
import { Button, Card, forSale, Note, PlayHours } from '../../ui'
import { placeOf } from '../(public)/steps'

/**
 * Where someone has just reached for something their plan leaves out, and only there, the plan
 * that has it: what it is, what it costs, a way to get it and a way to carry on without. Getting
 * it goes through the checkout page (the agreement, then paying), which brings them back to the
 * page they were on, with what they chose kept. Where this Blockly
 * sells no plans, it is only the line that says why.
 *
 * Each is counted as it is drawn, and as its button or its way on is pressed (lib/paying.ts).
 */
export function PlusOffer({
  why,
  reason,
  plan = 'plus',
  next,
  instead,
}: {
  /** The plan's edge, as the API words it: "Modpacks come with Plus." */
  why: string
  reason: UpgradeReason
  plan?: string
  /** Where to land after paying; the page as it is now when not given. */
  next?: string
  /** The way to carry on without it. */
  instead?: { label: string; onClick: () => void }
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const path = usePathname()
  const overview = useQuery(trpc.account.overview.queryOptions())
  const listed = useQuery(trpc.billing.plans.queryOptions())
  const sells = overview.data?.features.find((f) => f.feature === 'billing')?.available === true
  const offered = overview.data?.plans.find((p) => p.key === plan)?.entitlements
  // The line alone where there is nothing to buy: no plans sold here, or that plan already theirs.
  const unsold = listed.data?.some((p) => p.key === plan && !forSale(p)) === true
  const lineOnly = !sells || unsold || offered === undefined || overview.data?.plan.key === plan
  const counted = { plan, reason, where: placeOf(path) }
  useShown(counted, overview.data === undefined ? null : !lineOnly)
  if (lineOnly) return <Note tone="info">{why}</Note>
  const name = `${plan[0]?.toUpperCase() ?? ''}${plan.slice(1)}`
  return (
    <Card
      flat
      title={why}
      description={
        <>
          {dollars(offered.monthlyPriceCents)} a month ·{' '}
          {offered.includedUnits === null ? (
            'Unlimited hours of play'
          ) : (
            <PlayHours hours={offered.includedUnits} priceCents={offered.monthlyPriceCents}>
              {offered.includedUnits} hours of play
            </PlayHours>
          )}{' '}
          · {offered.maxServers === 1 ? '1 server' : `up to ${offered.maxServers} servers`}
        </>
      }
      footer={
        <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              upgradePressed(counted)
              router.push(
                checkoutHref({
                  plan,
                  reason,
                  next: next ?? `${window.location.pathname}${window.location.search}`,
                }),
              )
            }}
          >
            Get {name}
          </Button>
          {instead && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                upgradeDeclined(counted)
                instead.onClick()
              }}
            >
              {instead.label}
            </Button>
          )}
        </div>
      }
    />
  )
}

/**
 * Counts an offer once where it is drawn, as soon as the account's answer says how it is shown
 * (`button`, or null while that is not known yet), and again only if the plan or reason changes.
 */
function useShown(offered: { plan: string; reason: UpgradeReason; where: string }, button: boolean | null) {
  const { plan, reason, where } = offered
  useEffect(() => {
    if (button !== null) upgradeShown({ plan, reason, where }, button)
  }, [plan, reason, where, button])
}

/** A price as it is said: "$15", or "$4.50" where there are cents. */
const dollars = (cents: number) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`

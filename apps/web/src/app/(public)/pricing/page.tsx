// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicPlan } from '@blockly/contracts'
import type { Metadata } from 'next'
import Link from 'next/link'
import { digits, pixel } from '../../../landing/fonts'
import { bedrockLive } from '../../../lib/bedrock'
import { publicPlans } from '../../../lib/plans'
import { canonicalOrigin, pageMetadata } from '../../../lib/site'
import { appSchema, JsonLd } from '../../../lib/structured-data'
import { cardsOf, plansSaid, priceOf } from '../../../ui'
import { PlanCards } from '../../../ui/plan-card'
import { guideHref, publishedGuides } from '../guides'
import { PricingCard } from './get-plan'
import { byKind, Questions, yearSaid } from './questions'

/** The title and description say the plans' own numbers, or nothing about them when the table can't be read. */
export async function generateMetadata(): Promise<Metadata> {
  const { free, core, plus } = byKind(await publicPlans())
  const paid = [core, plus].filter((plan): plan is PublicPlan => plan !== undefined)
  return pageMetadata({
    title:
      paid.length > 0
        ? `Pricing: a free trial, then ${paid.map((plan) => `${plan.name} for ${priceOf(plan.monthlyPriceCents)}`).join(' or ')}`
        : 'Pricing',
    description:
      free && core
        ? `${core.name} starts free, with ${free.totalHours ? `${free.totalHours} hours and ` : ''}no card, for you and ${core.maxPlayers - 1} friends.${plus ? ` ${plus.name} adds mods, plugins and bigger groups.` : ''}`
        : 'Core starts free, for you and your friends. Plus adds mods, plugins and bigger groups.',
    path: '/pricing',
  })
}

/**
 * What Blockly costs, for anyone: the paid plans, the first of them starting with the free trial,
 * in the words people choose on, and the few
 * questions they ask before paying. Every number comes from the plan table the control plane
 * enforces, so nothing here can promise what a server won't do.
 */
export default async function PricingPage() {
  const plans = await publicPlans()
  const { plus } = byKind(plans)
  const { trial, cards, starter } = cardsOf(plans)
  const bedrock = bedrockLive()
  const costGuide = publishedGuides().find((guide) => guide.slug === 'minecraft-server-cost')
  return (
    <>
      <JsonLd schema={appSchema(plans, canonicalOrigin())} />
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          {plansSaid(plans)}.
        </h1>
      </header>
      <PlanCards className={`${pixel.variable} ${digits.variable}`}>
        {cards.map((plan) => (
          <PricingCard
            key={plan.key}
            plan={plan}
            plans={plans}
            trial={plan === starter ? trial : undefined}
            bedrock={bedrock}
          />
        ))}
      </PlanCards>
      <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
        Hours only count while your server is running, and it sleeps when nobody’s on. Joining wakes it,
        usually in a couple of seconds; the first start, or one after a change, can take up to a minute.
      </p>
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        Prices are in US dollars and include VAT where it applies. Paid plans renew monthly until you cancel;
        {yearSaid(plus, ` a year of ${plus?.name} is paid once and doesn’t renew on its own.`)} Cancelling
        within 14 days of buying gets you a full refund if you’ve played less than 30 hours: see{' '}
        <Link href="/legal/refunds">Refunds and cancellation</Link>.
      </p>

      <Questions plans={plans} />
      {costGuide && (
        <p className="type-body-sm">
          <Link href={guideHref(costGuide)}>What does it cost to play?</Link> How a server’s hours work, and
          what decides the price.
        </p>
      )}
    </>
  )
}

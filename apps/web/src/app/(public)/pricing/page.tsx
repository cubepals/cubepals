// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicPlan } from '@blockly/contracts'
import type { Metadata } from 'next'
import Link from 'next/link'
import { digits, pixel } from '../../../landing/fonts'
import { FULL_REFUND_UNDER_HOURS } from '../../../legal/figures'
import { bedrockLive } from '../../../lib/bedrock'
import { pricedPlans } from '../../../lib/plans'
import { canonicalOrigin, pageMetadata } from '../../../lib/site'
import { appSchema, JsonLd } from '../../../lib/structured-data'
import { cardsOf, plansSaid, priceOf } from '../../../ui'
import { PlanCards } from '../../../ui/plan-card'
import { guideHref, publishedGuides } from '../guides'
import { PricingCard } from './get-plan'
import { byKind, Questions, yearSaid } from './questions'

/**
 * The title and description say what the cards say (`pricedPlans`), or nothing about the plans
 * when they can't be read, and Core's Java and Bedrock friends where Bedrock is on.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { free, core, plus } = byKind(await pricedPlans())
  const paid = [core, plus].filter((plan): plan is PublicPlan => plan !== undefined)
  return pageMetadata({
    title:
      paid.length > 0
        ? `Pricing: a free trial, then ${paid.map((plan) => `${plan.name} for ${priceOf(plan.monthlyPriceCents)}`).join(' or ')}`
        : 'Pricing',
    description:
      free && core
        ? `${core.name} starts free, with ${free.totalHours ? `${free.totalHours} hours and ` : ''}no card, for you and ${core.maxPlayers - 1} friends${bedrockLive() ? ' on Java and Bedrock' : ''}.${plus ? ` ${plus.name} adds mods, plugins and bigger groups.` : ''}`
        : 'Core starts free, for you and your friends. Plus adds mods, plugins and bigger groups.',
    path: '/pricing',
  })
}

/**
 * What Blockly costs, for anyone: the paid plans, the first of them starting with the free trial,
 * in the words people choose on, a quiet way to give Plus, and the few
 * questions they ask before paying. Every number comes from the one reading of the plans its
 * title read too (`pricedPlans`): what the control plane offers a new subscriber now.
 */
export default async function PricingPage() {
  const plans = await pricedPlans()
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
      {plus && (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          Know someone who’d like {plus.name}? <Link href="/gift">Give it as a gift</Link>.
        </p>
      )}
      <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
        Hours only count while your server is running, and it sleeps when nobody’s on. Joining wakes it,
        usually in a couple of seconds; the first start, or one after a change, can take up to a minute.
      </p>
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        Prices are in US dollars and include VAT where it applies. Paid plans renew monthly until you cancel
        {yearSaid(plus, `; a year of ${plus?.name} is paid once and doesn’t renew on its own`)}. Cancel within
        14 days of buying a paid plan having played less than {FULL_REFUND_UNDER_HOURS} hours, and you get a
        full refund the first time; past {FULL_REFUND_UNDER_HOURS} hours, or if you’ve had a full refund
        before, you pay for the hours you played: see{' '}
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

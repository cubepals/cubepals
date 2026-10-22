// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicPlan } from '@blockly/contracts'
import type { Metadata } from 'next'
import Link from 'next/link'
import { bedrockLive } from '../../../lib/bedrock'
import { hoursSaid, publicPlans } from '../../../lib/plans'
import { canonicalOrigin, pageMetadata } from '../../../lib/site'
import { appSchema, JsonLd } from '../../../lib/structured-data'
import { forSale, PlanCard, priceOf } from '../../../ui'
import { guideHref, publishedGuides } from '../guides'
import { seenMark } from '../steps'
import { GetPlan } from './get-plan'
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
    description: free
      ? `A free trial of ${hoursSaid(free)}, for up to ${free.maxPlayers} players.${core ? ` ${core.name} for you and ${core.maxPlayers - 1} friends.` : ''}${plus ? ` ${plus.name} for mods, plugins and bigger groups.` : ''}`
      : 'Start with a free trial. Core for friends on vanilla, Plus for mods and bigger groups.',
    path: '/pricing',
  })
}

/** What bigger groups run on, said under the plan that has them. */
const LARGE_SERVERS =
  'Big modpacks and groups of 20 or more run on a large server, which counts two hours for each hour it runs. Groups of more than 50 run on the largest, which counts four.'

/**
 * What Blockly costs, for anyone: three plans, in the words people choose on, and the few
 * questions they ask before paying. Every number comes from the plan table the control plane
 * enforces, so nothing here can promise what a server won't do.
 */
export default async function PricingPage() {
  const plans = await publicPlans()
  const { core, plus } = byKind(plans)
  // The plan the trial leads to.
  const paid = [core, plus].find((plan) => plan !== undefined && forSale(plan))
  const costGuide = publishedGuides().find((guide) => guide.slug === 'minecraft-server-cost')
  return (
    <>
      <JsonLd schema={appSchema(plans, canonicalOrigin())} />
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          {paid
            ? `Start with a free trial. ${paid.name} when it ends${plus && plus !== paid ? `, ${plus.name} for mods` : ''}.`
            : 'Start with a free trial.'}
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          Hours only count while your server is running, and it sleeps when nobody’s on. Joining wakes it,
          usually in a couple of seconds; the first start, or one after a change, can take up to a minute.
        </p>
      </header>
      <div className="bk-plans">
        {plans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            mark={seenMark(`plan_${plan.key}`)}
            bedrock={bedrockLive()}
            note={plan === plus ? LARGE_SERVERS : undefined}
            action={
              <GetPlan
                plan={plan.key}
                name={plan.name}
                paid={plan.monthlyPriceCents > 0}
                yearlyCents={plan.yearlyPriceCents}
                available={forSale(plan)}
              />
            }
          />
        ))}
      </div>
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

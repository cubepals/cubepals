// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from 'next'
import Link from 'next/link'
import { dollars, EXTRA_HOUR_CENTS } from '../../../legal/figures'
import { daysSaid, publicPlans } from '../../../lib/plans'
import { canonicalOrigin, pageMetadata } from '../../../lib/site'
import { appSchema, JsonLd } from '../../../lib/structured-data'
import { PlanCard, priceOf } from '../../../ui'
import { guideHref, publishedGuides } from '../guides'
import { GetPlan } from './get-plan'

/** The title and description say the plans' own numbers, or nothing about them when the table can't be read. */
export async function generateMetadata(): Promise<Metadata> {
  const plans = await publicPlans()
  const free = plans.find((plan) => plan.monthlyPriceCents === 0)
  const paid = plans.find((plan) => plan.monthlyPriceCents > 0)
  return pageMetadata({
    title: paid ? `Pricing: Free, or ${paid.name} for ${priceOf(paid.monthlyPriceCents)}` : 'Pricing',
    description: free
      ? `Free to play with friends: ${free.includedHours} hours a month for up to ${free.maxPlayers} players.${paid ? ` ${paid.name} for modpacks, more play and bigger groups.` : ''}`
      : 'Free to play Minecraft with friends. Plus for modpacks, more play and bigger groups.',
    path: '/pricing',
  })
}

/**
 * What Blockly costs, for anyone: two plans, in the words people choose on, and the few
 * questions they ask before paying. Every number comes from the plan table the control plane
 * enforces, so nothing here can promise what a server won't do.
 */
export default async function PricingPage() {
  const plans = await publicPlans()
  const free = plans.find((plan) => plan.monthlyPriceCents === 0)
  const paid = plans.find((plan) => plan.monthlyPriceCents > 0)
  const costGuide = publishedGuides().find((guide) => guide.slug === 'minecraft-server-cost')
  return (
    <>
      <JsonLd schema={appSchema(plans, canonicalOrigin())} />
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          {paid
            ? `Free to play with friends. ${paid.name} when you want more.`
            : 'Free to play with friends.'}
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          Hours only count while your server is running, and it sleeps when nobody’s on.
        </p>
      </header>
      <div className="bk-plans">
        {plans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            action={<GetPlan plan={plan.key} name={plan.name} paid={plan.monthlyPriceCents > 0} />}
          />
        ))}
      </div>
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        Big modpacks and groups of 20 or more run on a large server, which counts two hours for each hour it
        runs.
      </p>
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        Prices are in US dollars and include VAT where it applies. Paid plans renew monthly until you cancel,
        and cancelling within 14 days of buying gets you a full refund if you’ve played less than 30 hours:
        see <Link href="/legal/refunds">Refunds and cancellation</Link>.
      </p>

      <section className="bk-stack" style={{ gap: 'var(--space-12)' }} aria-labelledby="questions">
        <h2 id="questions" className="type-heading-md" style={{ color: 'var(--ink)' }}>
          Questions
        </h2>
        <Question title="What counts as an hour?">
          Time your server is running. It sleeps {free?.sleepsAfterMinutes ?? 10} minutes after everyone
          leaves
          {paid && paid.sleepsAfterMinutes !== free?.sleepsAfterMinutes
            ? ` (${paid.sleepsAfterMinutes} on ${paid.name})`
            : ''}
          , and a start that fails never uses your hours.
        </Question>
        <Question title="What if we run out?">
          Your server sleeps until the 1st, when the hours start again.
          {paid
            ? ` On ${paid.name} you can allow extra hours instead, at ${dollars(EXTRA_HOUR_CENTS)} each, up to a limit you set, added to your next payment.`
            : ''}{' '}
          Nothing is charged past your plan unless you allow it.
        </Question>
        <Question title="What happens to a world nobody plays?">
          It sleeps as soon as everyone leaves. After {daysSaid(free?.restsAfterDays ?? 14)} without play
          {paid ? ` (${daysSaid(paid.restsAfterDays)} on ${paid.name})` : ''} it rests in storage: joining
          still wakes it, it just takes a couple of minutes.
          {free?.deletedAfterDays
            ? ` A free world nobody has played for ${daysSaid(free.deletedAfterDays)} is deleted, and we email you twice before, with a way to keep it and a download.`
            : ''}
          {paid ? ` ${paid.name} worlds are kept for as long as you have ${paid.name}.` : ''}
        </Question>
        <Question title="What’s plain Minecraft?">
          The game as it comes, with nothing for your friends to install. Paper runs too, without plugins.
          {paid ? ` Mods, plugins, modpacks and datapacks come with ${paid.name}.` : ''}
        </Question>
        {paid && (
          <Question title="Can I cancel?">
            Any time, from your account. You keep {paid.name} until the end of the month you paid for. Your
            worlds stay; a modded one waits, whole, until you have {paid.name} again.
          </Question>
        )}
        <Question title="Bedrock or consoles?">Not yet. Cubepals runs Minecraft: Java Edition.</Question>
        <Question title="Which modpacks?">
          Modrinth packs, from a search or a link. A pack from CurseForge or a launcher runs from its file:
          download its server pack, or export it, and drop it in. Cubepals can’t install straight from
          CurseForge.
        </Question>
      </section>
      {costGuide && (
        <p className="type-body-sm">
          <Link href={guideHref(costGuide)}>What does it cost to play?</Link> How a server’s hours work, and
          what decides the price.
        </p>
      )}
    </>
  )
}

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details>
      <summary className="type-body bk-disclosure" style={{ color: 'var(--ink)' }}>
        {title}
      </summary>
      <p className="type-body" style={{ color: 'var(--ink-muted)', marginBlockStart: 'var(--space-8)' }}>
        {children}
      </p>
    </details>
  )
}

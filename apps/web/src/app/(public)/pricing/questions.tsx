// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The few questions people ask before paying, on the pricing page. Every number comes from the
 * plan table the control plane enforces. Not for the plans themselves, which are the cards above.
 */
import type { PublicPlan } from '@blockly/contracts'
import { dollars, EXTRA_HOUR_CENTS } from '../../../legal/figures'
import { bedrockLive } from '../../../lib/bedrock'
import { daysSaid, hoursAgainSaid } from '../../../lib/plans'
import { eachOf, extraHourOf, forSale } from '../../../ui'
import { detailMark } from '../steps'

/** The plans by what each is: the trial, the plan for friends on vanilla, and the one with mods. */
export function byKind(plans: readonly PublicPlan[]) {
  return {
    free: plans.find((plan) => plan.monthlyPriceCents === 0),
    core: plans.find((plan) => plan.key === 'core'),
    plus: plans.find((plan) => plan.mods),
  }
}

/** "Core and Plus", or the one name: the plans that share a figure are said together. */
const named = (plans: readonly (PublicPlan | undefined)[]) =>
  plans
    .filter((plan): plan is PublicPlan => plan !== undefined)
    .map((plan) => plan.name)
    .join(' and ')

/** What the page says about a year of the paid plan, where the plan is sold by the year. */
export const yearSaid = (paid: PublicPlan | undefined, said: string) => (paid?.yearlyPriceCents ? said : '')

/** What happens once the trial's hours are played, where it has them: "When the trial’s 20 hours…". */
function onceSaid(free: PublicPlan | undefined, next: PublicPlan | undefined): string {
  if (!free?.totalHours || !next) return ''
  return ` When the trial’s ${free.totalHours} hours are played, it ends and nothing is charged. Your world is kept and you can still download it, and ${next.name} starts it again.`
}

/** The plans that share one figure with `paid`, named: "Core and Plus" when both have it. */
const sharing = (paid: PublicPlan, plus: PublicPlan | undefined, same: (plan: PublicPlan) => boolean) =>
  named([paid, plus && plus !== paid && same(plus) ? plus : undefined])

/** How long after everyone leaves a server sleeps, and where a plan differs. */
function sleepsSaid(
  free: PublicPlan | undefined,
  paid: PublicPlan | undefined,
  plus: PublicPlan | undefined,
) {
  const minutes = free?.sleepsAfterMinutes ?? 10
  if (!paid || paid.sleepsAfterMinutes === free?.sleepsAfterMinutes) return `${minutes} minutes`
  const on = sharing(paid, plus, (plan) => plan.sleepsAfterMinutes === paid.sleepsAfterMinutes)
  return `${minutes} minutes (${paid.sleepsAfterMinutes} on ${on})`
}

/** What happens to a world nobody plays, and where a plan keeps it longer. */
function restsSaid(free: PublicPlan | undefined, paid: PublicPlan | undefined, plus: PublicPlan | undefined) {
  const paidDays = paid
    ? ` (${daysSaid(paid.restsAfterDays)} on ${sharing(paid, plus, (plan) => plan.restsAfterDays === paid.restsAfterDays)})`
    : ''
  const deleted = free?.deletedAfterDays
    ? ` On the trial, a world nobody has played for ${daysSaid(free.deletedAfterDays)} is deleted, and we email you twice before, with a way to keep it and a download.`
    : ''
  const kept = paid ? ' A world on a paid plan is kept for as long as you have the plan.' : ''
  return { paidDays, after: `${deleted}${kept}` }
}

/** What running out says: when hours start again, what the trial's end is, and where extra hours can be allowed. */
function runOutSaid(
  plans: readonly PublicPlan[],
  free: PublicPlan | undefined,
  paid: PublicPlan | undefined,
) {
  const extras = plans.filter((plan) => extraHourOf(plan) !== null)
  const extra =
    extras.length > 0
      ? ` On ${named(extras)} you can allow extra hours instead, at ${dollars(EXTRA_HOUR_CENTS)} each, up to a limit you set, added to your next payment.`
      : ''
  return `Your server sleeps until ${hoursAgainSaid(plans)}.${onceSaid(free, paid)}${extra} Nothing is charged past your plan unless you allow it.`
}

/** What cancelling does: the month paid for is kept, worlds stay, and a modded one waits for Plus. */
function cancelSaid(plus: PublicPlan | undefined): string {
  const waits = plus ? `; a modded one waits, whole, until you have ${plus.name} again` : ''
  const year = yearSaid(
    plus,
    ' A year can be stopped early too: after its first 14 days, you get back each whole month left.',
  )
  return `Any time, from your account. You keep your plan until the end of the month you paid for. Your worlds stay${waits}.${year}`
}

/** Changing plan: up to Plus changes the one subscription now, and down to Core waits for the month's end. */
function changeSaid(core: PublicPlan, plus: PublicPlan): string {
  return `Yes, from your account. ${core.name} to ${plus.name} starts at once: you pay the difference for the rest of the month, and your subscription stays one. ${plus.name} to ${core.name} is offered on your account page too: ${core.name} starts when the month you paid for ends, you keep ${plus.name} until then, and there is nothing to end first. Your worlds stay as they are: a modded one waits for ${plus.name} rather than losing anything.`
}

/** Whether friends on Bedrock can join, as this Cubepals has it. */
const bedrockSaid = (on: boolean) =>
  on
    ? 'Yes. Friends on Bedrock, on phones, tablets or Windows, join the same server as Java friends, with the same address. Xbox, PlayStation and Switch can’t add a server, so they can’t join. A server with mods can’t let them in yet.'
    : 'Not yet. Cubepals runs Minecraft: Java Edition. Bedrock support is coming soon, so friends on phones and tablets can join too.'

export function Questions({ plans }: { plans: readonly PublicPlan[] }) {
  const { free, core, plus } = byKind(plans)
  // What the trial leads to: the first plan that is for sale.
  const paid = [core, plus].find((plan) => plan !== undefined && forSale(plan))
  const shared = paid ? eachOf(paid) : null
  const rests = restsSaid(free, paid, plus)
  return (
    <section className="bk-stack" style={{ gap: 'var(--space-12)' }} aria-labelledby="questions">
      <h2 id="questions" className="type-heading-md" style={{ color: 'var(--ink)' }}>
        Questions
      </h2>
      <Question which="hours" title="What counts as an hour?">
        Time your server is running. It sleeps {sleepsSaid(free, paid, plus)} after everyone leaves, and a
        start that fails never uses your hours.
      </Question>
      {paid && shared && (
        <Question which="everyone_pays" title="Does everyone need to pay?">
          No. One person has {paid.name} and their friends just join. If {shared.friends} of you share it,
          that’s {shared.each} each. Hours count while the server runs, not for each player, so an evening
          with everyone on uses the same hours as an evening alone.
        </Question>
      )}
      <Question which="run_out" title="What if we run out?">
        {runOutSaid(plans, free, paid)}
      </Question>
      <Question which="unplayed_world" title="What happens to a world nobody plays?">
        It sleeps as soon as everyone leaves. After {daysSaid(free?.restsAfterDays ?? 14)} without play
        {rests.paidDays} it rests in storage: joining still wakes it, it just takes a couple of minutes.
        {rests.after}
      </Question>
      <Question which="plain_minecraft" title="What’s plain Minecraft?">
        The game as it comes, with nothing for your friends to install. Paper runs too, without plugins.
        {plus ? ` Mods, plugins, modpacks and datapacks come with ${plus.name}.` : ''}
      </Question>
      {paid && (
        <Question which="cancel" title="Can I cancel?">
          {cancelSaid(plus)}
        </Question>
      )}
      {core && plus && (
        <Question which="change_plan" title="Can I change plan?">
          {changeSaid(core, plus)}
        </Question>
      )}
      <Question which="bedrock" title="Bedrock or consoles?">
        {bedrockSaid(bedrockLive())}
      </Question>
      <Question which="modpacks" title="Which modpacks?">
        Modrinth packs, from a search or a link. A pack from CurseForge or a launcher runs from its file:
        download its server pack, or export it, and drop it in. Cubepals can’t install straight from
        CurseForge.
      </Question>
    </section>
  )
}

/** One question, opened in place; `which` is its code, counted as it opens. */
function Question({ which, title, children }: { which: string; title: string; children: React.ReactNode }) {
  return (
    <details {...detailMark(which)}>
      <summary className="type-body bk-disclosure" style={{ color: 'var(--ink)' }}>
        {title}
      </summary>
      <p className="type-body" style={{ color: 'var(--ink-muted)', marginBlockStart: 'var(--space-8)' }}>
        {children}
      </p>
    </details>
  )
}

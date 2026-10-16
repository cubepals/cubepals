// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The guide to how much a Minecraft server costs. Every price, hour and limit is
 * rendered from the plan table, and the play habits from the plan cards' own guidance, so nothing
 * here can drift from what the pricing page says.
 */
import type { PublicPlan } from '@blockly/contracts'
import type { Metadata } from 'next'
import Link from 'next/link'
import { dollars, EXTRA_HOUR_CENTS } from '../../../../legal/figures'
import { daysSaid, hoursAgainSaid, hoursSaid } from '../../../../lib/plans'
import { PLAY_HABITS, planPoints, priceOf } from '../../../../ui'
import { FactTable, GuideArticle, GuideLink, guideMetadata, guidePlans, Part, Questions } from '../article'

const SLUG = 'minecraft-server-cost'

/** The most a month's hours cover, as the plan cards say it: "a couple of evenings a week". */
const covers = (hours: number) =>
  PLAY_HABITS.filter((habit) => habit.hours <= hours)
    .at(-1)
    ?.said.toLowerCase()

/**
 * Who a plan's hours cover, in a sentence. A day's hours start again every day, so they cover a
 * group's play by the day, however many days a week; a month's are set against the habits.
 */
function howFar(plan: PublicPlan): string {
  if (plan.totalHours !== null)
    return `The trial’s ${plan.totalHours} hours, at most ${plan.includedHours} a day, are enough for a group to find out whether it plays.`
  if (plan.per === 'day')
    return `${plan.name} covers a group that plays up to ${plan.includedHours} hours a day, every day.`
  const covered = covers(plan.includedHours)
  return covered
    ? `${plan.name}’s ${plan.includedHours} hours a month cover a group that plays ${covered}.`
    : ''
}

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default async function Guide() {
  const { free, paid } = await guidePlans()
  const plans = [free, paid].filter((plan) => plan !== undefined)
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        What a Minecraft server for a group of friends costs comes down to how much you play, how many of you
        there are, and whether you want mods. This guide is for Minecraft: Java Edition.
      </p>

      <Part id="paying-for" title="What you’re paying for">
        <p>
          Most of the time, a server for friends sits empty: everyone has school, work or sleep. Paying for a
          machine by the month pays for those empty hours too. On Cubepals you pay for hours of play instead.
          A server only uses hours while it’s running, and it goes to sleep when nobody’s on.
        </p>
      </Part>

      <Part id="monthly" title="Do you have to pay monthly?">
        <p>
          No.
          {free
            ? ` There’s a free trial of ${hoursSaid(free)}, with no card, and nothing is charged when it ends.`
            : ' There’s a free trial, with no card.'}
          {paid ? ` ${paid.name} is ${priceOf(paid.monthlyPriceCents)}, and you can cancel any time.` : ''}{' '}
          Here’s what each one includes:
        </p>
        {plans.length > 0 && (
          <FactTable
            head={plans.map((plan) => `${plan.name}, ${priceOf(plan.monthlyPriceCents)}`)}
            rows={[0, 1, 2, 3].map((i) => plans.map((plan) => planPoints(plan)[i]))}
          />
        )}
        <p>
          An hour is an hour your server is running, shared by everyone on it.
          {free?.sleepsAfterMinutes
            ? ` It sleeps ${free.sleepsAfterMinutes} minutes after everyone leaves${
                paid?.sleepsAfterMinutes && paid.sleepsAfterMinutes !== free.sleepsAfterMinutes
                  ? ` (${paid.sleepsAfterMinutes} on ${paid.name})`
                  : ''
              }, and a start that fails never uses your hours.`
            : ''}
        </p>
        <p>
          If you run out, your server sleeps until {hoursAgainSaid(plans)}. On a paid plan you can allow extra
          hours instead, at {dollars(EXTRA_HOUR_CENTS)} each, up to a limit you set; nothing is charged past
          your plan unless you allow it. Prices are in US dollars and include VAT where it applies;{' '}
          <Link href="/pricing">Pricing</Link> has the details.
        </p>
      </Part>

      {plans.length > 0 && (
        <Part id="how-far" title="How far the hours go">
          {plans.some((plan) => plan.per === 'month') && (
            <>
              <p>How much a group plays in a month, roughly:</p>
              <ul>
                {PLAY_HABITS.map((habit) => (
                  <li key={habit.hours}>
                    {habit.said}: {habit.hours === 90 ? '90 hours or more' : `about ${habit.hours} hours`}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p>
            {plans.map(howFar).join(' ')} Hours only count while someone is on, or in the minutes before it
            sleeps. <GuideLink to="minecraft-server-that-sleeps">How the sleeping works</GuideLink>.
          </p>
        </Part>
      )}

      <Part id="yourself" title="Running one yourself">
        <p>
          Mojang’s server software is free to download, and runs on your own computer with Java. That costs
          nothing but the computer and its power, but the computer has to stay on whenever anyone wants to
          play, and friends outside your home usually can’t reach it until you’ve opened a port on your
          router.{' '}
          <GuideLink to="minecraft-server-without-port-forwarding">Why that step goes wrong</GuideLink>.
        </p>
      </Part>

      <Questions
        items={[
          {
            question: 'Is it free?',
            answer: free
              ? `To try, yes: the free trial is ${hoursSaid(free)}, for up to ${free.maxPlayers} players, plain Minecraft or Paper.`
              : 'To try, yes: see Pricing.',
          },
          {
            question: 'Do I need a card?',
            answer: 'Not for the free trial.',
          },
          {
            question: 'What if a big modpack needs more?',
            answer: (
              <>
                Big modpacks and groups of 20 or more run on a large server, which counts two hours for each
                hour it runs, and groups of more than 50 on the largest, which counts four. You never pick its
                size: <GuideLink to="minecraft-server-ram">how much memory a server needs</GuideLink> explains
                why.
              </>
            ),
          },
          {
            question: 'What happens to a world nobody plays?',
            answer: free
              ? `It sleeps as soon as everyone leaves. After ${daysSaid(free.restsAfterDays)} without play it rests in storage; joining still wakes it, it just takes a couple of minutes.`
              : 'It sleeps as soon as everyone leaves, and joining wakes it.',
          },
        ]}
      />
    </GuideArticle>
  )
}

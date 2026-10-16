// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The guide to a Minecraft server that starts when someone joins, and sleeps when nobody plays: the
 * one page for both searches, so two pages never compete for them. It answers the question first,
 * with the self-host route (lazymc, Sleeping Server Starter) and when that is the better pick, then
 * how a Cubepals server does it.
 *
 * The timers come from the plan table. The list's line is the edge's sleeping notice (ASLEEP_MOTD,
 * apps/edge/agent.ts); the waiting join is its waiting room. Going to sleep, saving first and waking
 * on a join were watched on a local stack. A wake is said as it measures, never as a fixed number: a
 * server kept in memory while asleep (FLY_SUSPEND, apps/control/src/config/load.ts) is usually back
 * in a couple of seconds; a cold start, after a change or when the kept copy is gone, takes up to a
 * minute; a world resting in storage a couple of minutes. The self-host tools are described from
 * their own pages, and quoted where it matters.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { daysSaid, hoursSaid } from '../../../../lib/plans'
import { GuideArticle, GuideLink, guideMetadata, guidePlans, Part, Questions, Shot } from '../article'

const SLUG = 'minecraft-server-that-sleeps'
const PICTURES = `/guides/${SLUG}`

/** What the multiplayer list shows of a sleeping server, under its own message. apps/edge/agent.ts */
const ASLEEP_LINE = 'Sleeping · join to wake it up'

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default async function Guide() {
  const { free, paid } = await guidePlans()
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        For a server to start when someone joins, something has to answer at its address while it’s off, and
        start it on the first join. On a computer of your own, a small program such as lazymc does that. On
        Cubepals every server already works this way: your friends join from the normal game, and it wakes.
        This guide is for Minecraft: Java Edition.
      </p>

      <Part id="on-cubepals" title="How it works on Cubepals">
        <p>
          There’s nothing to install or switch on. The server stays in your friends’ Multiplayer list under
          the same address, and while it’s asleep the list says so: <strong>{ASLEEP_LINE}</strong>, under its
          own message and picture.
        </p>
        <p>
          They join like any server. The join waits while it wakes, and it’s usually back in a couple of
          seconds, with the world as they left it. Sometimes, such as the first join after a change, it takes
          up to a minute. One resting in storage after weeks without play takes a couple of minutes.
        </p>
        <Shot
          src={`${PICTURES}/asleep.png`}
          width={576}
          height={294}
          alt="A sleeping server’s page: a Sleeping pill and the line Nobody was on, so it went to sleep. Joining wakes it. Under it, the address maple-hollow.play.cubepals.com and a Wake it up button."
          caption="You can wake it from its page too, but nobody has to."
        />
        <p>Nobody has to start it for anyone, and you don’t need to be online for your friends to play.</p>
      </Part>

      <Part id="when" title="When does it go back to sleep?">
        <p>
          {free?.sleepsAfterMinutes
            ? `${free.sleepsAfterMinutes} minutes after everyone leaves${
                paid?.sleepsAfterMinutes && paid.sleepsAfterMinutes !== free.sleepsAfterMinutes
                  ? ` (${paid.sleepsAfterMinutes} on ${paid.name})`
                  : ''
              }, so someone who pops out for a minute comes back to it still running.`
            : 'A few minutes after everyone leaves.'}{' '}
          It saves the world before it stops.
        </p>
        <p>
          Hours only count while it’s running. A server for friends spends most of the week with nobody on it,
          and a sleeping one uses none of your hours in that time. That’s what lets{' '}
          {free ? `the free trial include ${hoursSaid(free)}` : 'the free trial work'} with nothing to pay.{' '}
          <GuideLink to="minecraft-server-cost">What a server costs</GuideLink> goes through the plans.
        </p>
      </Part>

      <Part id="yourself" title="Doing it yourself: lazymc and Sleeping Server Starter">
        <p>If you run your own server, two free programs make it start on a join:</p>
        <ul>
          <li>
            <a href="https://github.com/timvisee/lazymc">lazymc</a>, which says it puts “your Minecraft server
            to rest when idle”. It sits in front of the server, answers the list while it’s off, and starts it
            when someone joins. It can hold that join until the server is up.
          </li>
          <li>
            <a href="https://github.com/vincss/mcsleepingserverstarter">Sleeping Server Starter</a> does the
            same, and by default tells whoever joins “Waking server up, come back in a minute”, so they join
            again.
          </li>
        </ul>
        <p>
          Both run beside the server, on the machine that hosts it. That machine stays on, and your friends
          need to reach it, which at home usually means opening a port on your router:{' '}
          <GuideLink to="minecraft-server-without-port-forwarding">hosting without port forwarding</GuideLink>{' '}
          explains the ways around it. They rest the server, not the computer.
        </p>
      </Part>

      <Part id="which" title="Which one to pick">
        <p>
          Do it yourself if you already have a computer or a rented server that’s on all the time, you’re
          happy to keep it updated, and you want full control of it. lazymc costs nothing and does the job
          well.
        </p>
        <p>
          Pick Cubepals if nobody should have to keep a computer on, open a port, or look after the server.
          Every server starts on a join and sleeps when everyone leaves, with no setup.
        </p>
      </Part>

      <Part id="always-on" title="“I want it always on”">
        <p>
          Usually that means: nobody should have to ask you to start it. A server that wakes when someone
          joins does that, whoever joins and whenever. It isn’t running all the time, and that’s the point:
          you’d be paying for the hours nobody plays.
        </p>
      </Part>

      <Part id="long-rest" title="A world nobody plays for a while">
        <p>
          It sleeps as soon as everyone leaves.
          {free
            ? ` After ${daysSaid(free.restsAfterDays)} without play${
                paid ? ` (${daysSaid(paid.restsAfterDays)} on ${paid.name})` : ''
              } it rests in storage: joining still wakes it, it just takes a couple of minutes.`
            : ' After a while without play it rests in storage: joining still wakes it, it just takes a couple of minutes.'}
          {free?.deletedAfterDays
            ? ` On the trial, a world nobody has played for ${daysSaid(free.deletedAfterDays)} is deleted, and you’re emailed twice before, with a way to keep it and a download.`
            : ''}
        </p>
      </Part>

      <Questions
        items={[
          {
            question: 'Can a Minecraft server start automatically when a player joins?',
            answer:
              'Yes. On your own machine, a program such as lazymc starts it on a join. On Cubepals every server does it, with nothing to set up.',
          },
          {
            question: 'Can my friends start the server without me?',
            answer: 'Yes. Any of them can wake it by joining, whether or not you’re online.',
          },
          {
            question: 'What do my friends see while it’s asleep?',
            answer: `The server in their list as usual, with “${ASLEEP_LINE}” under its message. Joining is all it takes.`,
          },
          {
            question: 'Does it work on Bedrock?',
            answer:
              'Not yet. Cubepals servers are for Java Edition, so a friend on a phone or a console can’t join. Bedrock support is coming soon, so friends on phones and tablets can join too. Sleeping Server Starter has an option for Bedrock if you host your own.',
          },
          {
            question: 'Does sleeping lose anything?',
            answer: 'No. It saves the world before it stops, and wakes up with everything where it was.',
          },
          {
            question: 'Can I keep it from sleeping?',
            answer: (
              <>
                It sleeps when nobody’s on, so it never uses hours on an empty world. The plans and their
                timers are on <Link href="/pricing">Pricing</Link>.
              </>
            ),
          },
          {
            question: 'How do I make one?',
            answer: (
              <>
                <GuideLink to="minecraft-server-for-friends">Making a server for friends</GuideLink> goes step
                by step. Every Cubepals server starts on a join like this.
              </>
            ),
          },
        ]}
      />
    </GuideArticle>
  )
}

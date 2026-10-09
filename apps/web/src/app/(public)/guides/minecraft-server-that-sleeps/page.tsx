/**
 * The guide to a Minecraft server that sleeps when nobody plays. The timers come from the plan
 * table; going to sleep, saving first, and waking on a join were watched on a local stack. No wake
 * time is stated: none is measured on production yet.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { daysSaid } from '../../../../lib/plans'
import { GuideArticle, GuideLink, guideMetadata, guidePlans, Part, Questions, Shot } from '../article'

const SLUG = 'minecraft-server-that-sleeps'
const PICTURES = `/guides/${SLUG}`

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default async function Guide() {
  const { free, paid } = await guidePlans()
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        A Cubepals server is asleep most of the time, and wakes up when one of your friends joins. This guide
        is for groups on Minecraft: Java Edition: why it works that way, what your friends see, and what
        happens to the world.
      </p>

      <Part id="why" title="Why sleep?">
        <p>
          Hours only count while it’s running. A server for friends spends most of the week with nobody on it,
          and a sleeping one uses none of your hours in that time. That’s what lets{' '}
          {free ? `${free.name} include ${free.includedHours} hours of play a month` : 'the free plan work'}{' '}
          with nothing to pay. <GuideLink to="minecraft-server-cost">What a server costs</GuideLink> goes
          through the plans.
        </p>
      </Part>

      <Part id="what-friends-see" title="What your friends see">
        <p>
          Nothing different. The server stays in their Multiplayer list under the same address, and they join
          like any server. If it’s asleep, give it a minute: joining wakes it, and once it’s up they’re in the
          world as they left it.
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

      <Part id="when" title="When does it go to sleep?">
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
            ? ` A free world nobody has played for ${daysSaid(free.deletedAfterDays)} is deleted, and you’re emailed twice before, with a way to keep it and a download.`
            : ''}
        </p>
      </Part>

      <Questions
        items={[
          {
            question: 'Can my friends join my server without me?',
            answer: 'Yes. Any of them can wake it by joining, whether or not you’re online.',
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
                by step. Every Cubepals server sleeps like this.
              </>
            ),
          },
        ]}
      />
    </GuideArticle>
  )
}

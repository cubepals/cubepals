// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The guide that compares Cubepals with Aternos for a group of friends on Java Edition. What it
 * says of Aternos comes only from Aternos’s own support pages, each read on 15 October 2026 and
 * linked where its fact is used; nothing else about Aternos is claimed. Everything about Cubepals
 * here comes from the plan table, so no number is typed by hand. The pictures are from a local
 * stack, and their alt text names no number either.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { bedrockLive } from '../../../../lib/bedrock'
import { daysSaid, hoursSaid } from '../../../../lib/plans'
import { OutLink } from '../../../../ui/out-link'
import {
  FactTable,
  GuideArticle,
  GuideLink,
  guideMetadata,
  guidePlans,
  Part,
  Questions,
  Shot,
} from '../article'

const SLUG = 'aternos-alternative'
const PICTURES = `/guides/${SLUG}`

/**
 * Aternos’s own pages, each read on 15 October 2026. The one fact a link goes with is the only
 * thing ever said from it.
 */
const ATERNOS = {
  ads: 'https://support.aternos.org/hc/en-us/articles/360034748092-You-are-using-an-adblocker',
  playtime: 'https://support.aternos.org/hc/en-us/articles/31771896948253-24-7-Hosting',
  queue: 'https://support.aternos.org/hc/en-us/articles/360026950812-Queue',
  dawn: 'https://support.aternos.org/hc/en-us/articles/38958320292637-Autostart-Aternos-servers-using-the-Dawn-launcher',
  hytale:
    'https://support.aternos.org/hc/en-us/articles/33239862001821-Creating-a-free-Hytale-server-with-Aternos',
  backups: 'https://support.aternos.org/hc/en-us/articles/360030845111-Server-deletion',
} as const

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default async function Guide() {
  const { free, paid } = await guidePlans()
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        Checked on 15 October 2026 against Aternos’s own pages. Each thing said about Aternos links to the
        page it comes from.
      </p>

      <Part id="short-version" title="The short version">
        <FactTable
          head={['What', 'Cubepals', 'Aternos']}
          rows={[
            [
              'How a server starts',
              <>
                A friend who joins wakes the server, from the game itself. Nothing is pressed on a website
                first.
              </>,
              <>
                You press Start on its website, and a friend who joins an offline server through{' '}
                <OutLink href={ATERNOS.dawn}>Dawn</OutLink> can start it too. When Aternos is full, starts
                wait in a <OutLink href={ATERNOS.queue}>queue</OutLink>.
              </>,
            ],
            [
              'What’s free',
              free
                ? `A free trial of ${hoursSaid(free)}, for up to ${free.maxPlayers} players.`
                : 'A free trial to start with, no card needed.',
              <>
                <OutLink href={ATERNOS.ads}>Free, paid for by the ads it shows</OutLink>, and a server can’t
                start while an adblocker is on.
              </>,
            ],
            [
              'Java and Bedrock',
              bedrockLive()
                ? 'Java and Bedrock friends join the same server, on one address.'
                : 'Java Edition today, and Bedrock is coming soon.',
              <>
                <OutLink href={ATERNOS.hytale}>Its servers run Java, Bedrock and Hytale</OutLink>.
              </>,
            ],
            [
              'Keeping the world',
              free
                ? `The world is saved every time the server stops. After ${daysSaid(free.restsAfterDays)} with nobody on it, it rests in storage, and joining still wakes it.`
                : 'The world is saved every time the server stops, and a sleeping one wakes with everything where it was.',
              <>
                <OutLink href={ATERNOS.backups}>Its backups are free, kept to your own Google Drive</OutLink>.
                A server not started for about three months is deleted.
              </>,
            ],
          ]}
        />
      </Part>

      <Part id="where-aternos" title="Where Aternos is the better choice">
        <p>
          <OutLink href={ATERNOS.ads}>Aternos is free, paid for by the ads it shows</OutLink>, and while
          someone is{' '}
          <OutLink href={ATERNOS.playtime}>online and active it puts no limit on their play</OutLink>. It runs{' '}
          <OutLink href={ATERNOS.hytale}>Hytale</OutLink> as well as Minecraft, and{' '}
          <OutLink href={ATERNOS.backups}>its backups go free to your own Google Drive</OutLink>. If your
          group wants free play with no hour limit, Aternos suits you better.
        </p>
      </Part>

      <Part id="how-a-server-starts" title="How a server starts">
        <p>
          On Cubepals, there is nothing to press. The server keeps its place in your friends’ Multiplayer list
          from the start, and a friend who joins wakes it from the game itself.
        </p>
        <Shot
          src={`${PICTURES}/asleep.png`}
          width={590}
          height={314}
          alt="A Cubepals server, Maple Hollow, marked Sleeping: Nobody was on, so it went to sleep. Joining wakes it. Its address, maple-hollow.play.cubepals.com, is the same as when it’s on, with a Copy address button and a Wake it up button below."
        />
        <p>
          On Aternos, you press Start on its website, and a friend who joins an offline server through{' '}
          <OutLink href={ATERNOS.dawn}>Dawn</OutLink> can start it too. When Aternos is at its full number of
          servers, starts wait in a <OutLink href={ATERNOS.queue}>queue</OutLink>.
        </p>
      </Part>

      <Part id="free-on-cubepals" title="What’s free on Cubepals">
        <p>
          {free
            ? `It starts with a free trial of ${hoursSaid(free)}, for up to ${free.maxPlayers} players, with no card, on plain Minecraft.`
            : 'It starts with a free trial, with no card, on plain Minecraft.'}{' '}
          {bedrockLive()
            ? 'Java and Bedrock friends join one server, on one address.'
            : 'It runs Java Edition today, and Bedrock is coming soon.'}{' '}
          {paid ? `Mods and modpacks come with ${paid.name}.` : 'Mods and modpacks come with the paid plan.'}{' '}
          Hours only count while the server is running, and it sleeps when nobody’s on, so the trial’s hours
          go on play rather than empty time. <Link href="/pricing">Pricing</Link> has the plans,{' '}
          <GuideLink to="minecraft-server-for-friends">making a server for friends</GuideLink> goes step by
          step, and <GuideLink to="minecraft-server-that-sleeps">how the sleeping works</GuideLink> explains
          the waking on a join.
        </p>
        <Shot
          src={`${PICTURES}/free-trial.png`}
          width={584}
          height={216}
          alt="The Free trial hours card on the Account page, which says they come once, to play on any day, with the hours left as a bar."
        />
      </Part>

      <Questions
        items={[
          {
            question: 'Is Cubepals free?',
            answer: free ? (
              <>
                To try, yes: the free trial is {hoursSaid(free)}, for up to {free.maxPlayers} players, on
                plain Minecraft. <Link href="/pricing">Pricing</Link> has the plans.
              </>
            ) : (
              <>
                To try, yes: there is a free trial, with no card. <Link href="/pricing">Pricing</Link> has the
                plans.
              </>
            ),
          },
          {
            question: 'Do my friends press anything to start it?',
            answer:
              'No. A friend who joins wakes the server, from the game itself. Nothing is pressed on a website first.',
          },
          {
            question: 'Who is Aternos suited to?',
            answer: (
              <>
                A group that wants free play with no hour limit.{' '}
                <OutLink href={ATERNOS.ads}>Aternos is free, paid for by the ads it shows</OutLink>, and while
                someone is{' '}
                <OutLink href={ATERNOS.playtime}>online and active it puts no limit on their play</OutLink>.
                If that is your group, Aternos suits you.
              </>
            ),
          },
        ]}
      />
    </GuideArticle>
  )
}

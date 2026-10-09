/**
 * The guide to making a Minecraft server for friends. Every step was done on a local stack, and the
 * pictures are from that run; numbers come from the plan table.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { GuideArticle, GuideLink, guideMetadata, guidePlans, Part, Questions, Shot } from '../article'

const SLUG = 'minecraft-server-for-friends'
const PICTURES = `/guides/${SLUG}`

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default async function Guide() {
  const { free, paid } = await guidePlans()
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        This is for a group of friends who play Minecraft: Java Edition and want a world of their own to come
        back to. At the end you’ll have an address to send them, and a server that’s there whenever one of
        them wants to play.
      </p>

      <Part id="three-ways" title="The three ways to do it">
        <p>
          <strong>On your own computer.</strong> Mojang’s server software is free. You install Java, run it,
          and open a port on your router so friends outside your home can reach it. It works, but your
          computer has to stay on whenever anyone plays, and the router step is where most people get stuck (
          <GuideLink to="minecraft-server-without-port-forwarding">why port forwarding goes wrong</GuideLink>
          ).
        </p>
        <p>
          <strong>On a host you set up yourself.</strong> You rent a server and choose its memory, its
          version, its software and its settings. Nothing runs on your computer, but every choice is yours to
          get right.
        </p>
        <p>
          <strong>On a host that makes those choices for you.</strong> You say what you want to play and who’s
          playing, and the rest is decided. Cubepals is this kind: the rest of this guide shows how it goes.
        </p>
      </Part>

      <Part id="step-by-step" title="Making one on Cubepals, step by step">
        <p>
          Sign up, then <strong>Create a server</strong>. It’s one page with a few questions, and each answer
          opens the next.
        </p>
        <ol>
          <li>
            <strong>What to play.</strong> Survival, Creative, Hardcore, Smoother survival, or a modpack. Pick
            one and the Minecraft version, the server software and its settings are chosen to match. There are
            games too:{' '}
            <GuideLink to="lifesteal-manhunt-skyblock-with-friends">
              Lifesteal, Manhunt and Skyblock
            </GuideLink>
            .
          </li>
          <li>
            <strong>Who’s playing.</strong> How many friends play at once. Bigger groups get a bigger server.
            On Free there’s one size, so this question doesn’t appear.
          </li>
          <li>
            <strong>Name it.</strong> Type a server name. Under it you’ll see the address your friends will
            use, made from the name.
          </li>
          <li>
            Press <strong>Create server</strong>. While it builds, the page shows the address to send your
            friends.
          </li>
        </ol>
        <Shot
          src={`${PICTURES}/what-to-play.png`}
          width={680}
          height={525}
          alt="The “What to play” question on the create page, with Survival picked. The other choices are Creative, Hardcore, Smoother survival, Create, A modpack and A pack you have."
        />
        <Shot
          src={`${PICTURES}/name-it.png`}
          width={680}
          height={268}
          alt="The “Name it” question with the server name Maple Hollow typed in. Under it: Friends join at maple-hollow.play.cubepals.com. The bar below says Survival, Minecraft 26.3, Europe, and has the Create server button."
          caption="The bar at the bottom says what’s being made, and holds the one button."
        />
      </Part>

      <Part id="how-friends-join" title="How your friends join">
        <p>
          Send them the address. In Minecraft: Java Edition they open <strong>Multiplayer</strong>, then{' '}
          <strong>Add Server</strong>, and paste it in. There’s no port to type and no number to remember.
          Their game needs to be on the same Minecraft version as the server, and the server’s page says which
          one that is.
        </p>
        <p>They join like any server. If it’s asleep, give it a minute.</p>
        <Shot
          src={`${PICTURES}/address.png`}
          width={576}
          height={202}
          alt="A server’s page showing it Online, its address maple-hollow.play.cubepals.com with a Copy address button, and the line: In Minecraft: Java Edition 26.3, open Multiplayer, then Add Server, and paste it."
        />
        <p>
          For friends who are new to it,{' '}
          <GuideLink to="play-minecraft-java-with-friends">the ways to play Java with friends</GuideLink>{' '}
          covers the rest, from Open to LAN to a server of your own.
        </p>
      </Part>

      <Part id="without-you" title="Can your friends play without you?">
        <p>
          Yes. Nobody has to start the server for them: when one of them joins, it wakes up, and when everyone
          has gone it goes back to sleep. You don’t need to be online, and your computer doesn’t need to be
          on. <GuideLink to="minecraft-server-that-sleeps">How the sleeping works</GuideLink>.
        </p>
      </Part>

      <Part id="only-friends" title="Keeping it to your friends">
        <p>
          Out of the box, anyone with the address can join. To keep it to the people you choose, open the
          server’s <strong>Players</strong> page. Under <strong>Who can join</strong> (“Anyone with the
          address, or only the people you add”), switch on <strong>Only people I add can join</strong>, then
          add each friend by their Minecraft name, exactly as it is in the game. Add yourself first.
        </p>
        <Shot
          src={`${PICTURES}/who-can-join.png`}
          width={576}
          height={374}
          alt="The Who can join card on the Players page, with Only people I add can join turned on and a field to add a player by their Minecraft name."
        />
        <p>
          Someone who isn’t on the list is turned away by the game itself, with “You are not whitelisted on
          this server!”
        </p>
      </Part>

      <Part id="cost" title="What it costs">
        {free ? (
          <p>
            {free.name} covers {free.includedHours} hours of play a month for up to {free.maxPlayers} players,
            with no card. Hours only count while the server is running, and it sleeps when nobody’s on.
            {paid ? ` ${paid.name} adds modpacks, bigger groups and more hours.` : ''}{' '}
            <GuideLink to="minecraft-server-cost">What a server costs</GuideLink> goes through it, and{' '}
            <Link href="/pricing">Pricing</Link> has the plans side by side.
          </p>
        ) : (
          <p>
            It’s free to start, with no card. <Link href="/pricing">Pricing</Link> has the plans, and{' '}
            <GuideLink to="minecraft-server-cost">what a server costs</GuideLink> goes through them.
          </p>
        )}
      </Part>

      <Questions
        items={[
          {
            question: 'Do I need to port forward?',
            answer: 'No. Your friends join by the address, and nothing runs on your computer or your router.',
          },
          {
            question: 'Does it work on Bedrock or consoles?',
            answer:
              'Not yet. Cubepals runs Minecraft: Java Edition, and Bedrock players, on phones or consoles, can’t join a Java server.',
          },
          {
            question: 'How many friends can join?',
            answer:
              free && paid
                ? `Up to ${free.maxPlayers} at once on ${free.name}, and up to ${paid.maxPlayers} on ${paid.name}.`
                : 'It depends on the plan: see Pricing.',
          },
        ]}
      />
    </GuideArticle>
  )
}

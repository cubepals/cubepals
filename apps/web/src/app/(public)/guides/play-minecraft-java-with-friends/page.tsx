// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The guide to playing Minecraft: Java Edition with friends. What it says about Open to LAN,
 * Essential and e4mc comes from their own pages, linked where they're named; the joining steps were
 * done on a local stack.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { GuideArticle, GuideLink, guideMetadata, Part, Questions, Shot } from '../article'

const SLUG = 'play-minecraft-java-with-friends'

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default function Guide() {
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        There are three ways to play Minecraft: Java Edition with friends: in the same house, far apart while
        one of you hosts, or on a server everyone joins. Which one fits comes down to one question: should
        your friends be able to play when you’re not on?
      </p>

      <Part id="same-wifi" title="On the same Wi-Fi: Open to LAN">
        <p>
          If everyone is on the same network, one of you loads a world, opens the pause menu, chooses{' '}
          <strong>Open to LAN</strong>, then <strong>Start LAN World</strong>. Everyone else on that network
          finds it in their Multiplayer list. Nothing to install, nothing to pay, and it only reaches people
          on the same network.
        </p>
      </Part>

      <Part id="far-apart-no-server" title="Far apart, without a server">
        <p>
          Some mods let one player host their own world over the internet while they play. Two that people
          use:
        </p>
        <ul>
          <li>
            <a href="https://essential.gg/wiki/start-hosting">Essential</a> offers free world hosting: you
            invite friends into your world from inside the game. Its own guide is plain about the catch: “The
            host needs to be online because they act as the server.”
          </li>
          <li>
            <a href="https://modrinth.com/mod/e4mc">e4mc</a> gives a world you’ve opened to LAN a public
            address that friends can join from anywhere. It describes itself as “a reverse tunneling reverse
            proxy for Minecraft”.
          </li>
        </ul>
        <p>
          Both need a mod loader such as Fabric or NeoForge, and both work only while the host is playing.
          When you log off, the world goes with you.
        </p>
      </Part>

      <Part id="far-apart-server" title="Far apart, with a server">
        <p>
          A server holds the world somewhere that isn’t anyone’s computer. Everyone joins the same address,
          whenever they like, and the world is there whether or not you are. In Java Edition they open{' '}
          <strong>Multiplayer</strong>, then <strong>Add Server</strong>, and paste the address.
        </p>
        <Shot
          src="/guides/minecraft-server-for-friends/address.png"
          width={576}
          height={202}
          alt="A Cubepals server’s page showing its address, maple-hollow.play.cubepals.com, with a Copy address button and the line: In Minecraft: Java Edition 26.3, open Multiplayer, then Add Server, and paste it."
        />
      </Part>

      <Part id="need-a-server" title="Do you need a server to play with friends?">
        <p>
          No, not to play together. Open to LAN works in one house, and a hosting mod works across the
          internet, as long as the host is playing. You need a server when your friends should be able to play
          without you: on different evenings, in different time zones, or after you’ve gone to bed. A server
          is also where a group’s world stays put when the person who started it moves on.
        </p>
      </Part>

      <Part id="quickest" title="The quickest way to a server">
        <p>
          On Cubepals it’s three decisions: what to play, who’s playing, and a name. Then you send the
          address.{' '}
          <GuideLink to="minecraft-server-for-friends">Making a server for friends, step by step</GuideLink>{' '}
          walks through it, and <GuideLink to="minecraft-server-cost">what a server costs</GuideLink> covers
          the money. The plans are on <Link href="/pricing">Pricing</Link>.
        </p>
      </Part>

      <Questions
        items={[
          {
            question: 'How do we play on different Wi-Fi?',
            answer: (
              <>
                With a hosting mod while the host plays, or with a server that’s always there to join. Hosting
                a server on your own computer usually means opening a port on your router:{' '}
                <GuideLink to="minecraft-server-without-port-forwarding">
                  hosting without port forwarding
                </GuideLink>{' '}
                explains the ways around it.
              </>
            ),
          },
          {
            question: 'Can my friends on Bedrock join?',
            answer:
              'Not on a Java server. Java Edition and Bedrock Edition don’t play together, so a friend on a phone or a console can’t join.',
          },
          {
            question: 'Do we all need the same version?',
            answer:
              'Yes. Your game has to be on the same Minecraft version as the server or the world you’re joining.',
          },
          {
            question: 'What about modded?',
            answer: (
              <>
                Everyone needs the same mods as the host or the server.{' '}
                <GuideLink to="play-a-modpack-with-friends">Playing a modpack with friends</GuideLink> covers
                it.
              </>
            ),
          },
        ]}
      />
    </GuideArticle>
  )
}

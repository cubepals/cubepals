// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The guide to making a Minecraft Bedrock server. What it says about Bedrock Dedicated Server comes
 * from Mojang's own page, linked where it's named. What it says of Cubepals was
 * done on staging: the steps on the create page, the address and the join lines a server's page
 * and settings show, and a Bedrock join waking a sleeping server. Any server without mods takes
 * Bedrock players, since each runs on Paper, so the steps ask for no particular setup. Where
 * Bedrock is off (`bedrockLive`), the Cubepals part says it is coming instead, and the page is
 * unlisted. The pictures are from a local stack with Bedrock on.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { bedrockLive } from '../../../../lib/bedrock'
import { OutLink } from '../../../../ui/out-link'
import { GuideArticle, GuideLink, guideMetadata, Part, Questions, Shot } from '../article'

const SLUG = 'minecraft-bedrock-server'
const PICTURES = `/guides/${SLUG}`

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default function Guide() {
  const live = bedrockLive()
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        A Bedrock server is a world your friends on phones, tablets and Windows join from the Servers tab,
        whether or not you’re playing.{' '}
        {live
          ? 'You can run one on your own computer, or make one your Java friends join too.'
          : 'Here is how to run one on your own computer.'}
      </p>

      <Part id="own-computer" title="On your own computer">
        <p>
          Mojang’s{' '}
          <OutLink href="https://www.minecraft.net/en-us/download/server/bedrock">
            Bedrock Dedicated Server
          </OutLink>{' '}
          is free, and runs on Windows 10 or later and on Ubuntu. You download it, start it, and open its port
          on your router, 19132 by default, so friends outside your home can reach it. Your computer has to
          stay on whenever anyone plays, and only Bedrock players can join it. The router step is where most
          people get stuck (
          <GuideLink to="minecraft-server-without-port-forwarding">why port forwarding goes wrong</GuideLink>
          ).
        </p>
      </Part>

      {live ? <OneServer /> : <ComingSoon />}

      {live && (
        <Questions
          items={[
            {
              question: 'Can Java and Bedrock players play together?',
              answer:
                'Yes, on the same server and in the same world. Java friends join from Multiplayer, Bedrock friends from Servers, with the same address.',
            },
            {
              question: 'Can friends on Xbox, PlayStation or Switch join?',
              answer: 'No. Those consoles can’t add a server, so they can’t join one by its address.',
            },
            {
              question: 'Do I need to port forward?',
              answer:
                'No. Your friends join by the address, and nothing runs on your computer or your router.',
            },
            {
              question: 'Is it free?',
              answer: (
                <>
                  It starts with a free trial, with no card. <Link href="/pricing">Pricing</Link> has the
                  plans.
                </>
              ),
            },
            {
              question: 'My server is older. Can Bedrock friends join it?',
              answer: (
                <>
                  Yes, if it has no mods. In its <strong>Settings</strong>, under{' '}
                  <strong>Bedrock friends</strong>, let them in.
                </>
              ),
            },
            {
              question: 'Can I keep Bedrock players out?',
              answer: (
                <>
                  Yes. In the server’s <strong>Settings</strong>, under <strong>Bedrock friends</strong>,
                  switch off <strong>Let them join</strong>. Java players aren’t affected.
                </>
              ),
            },
          ]}
        />
      )}
    </GuideArticle>
  )
}

/** Cubepals, where Bedrock is on: one server for both, step by step. */
function OneServer() {
  return (
    <>
      <Part id="one-server" title="One server for Java and Bedrock friends">
        <p>
          On Cubepals, Bedrock friends join any server without mods: the same server as Java friends, in the
          same world, with the same address. There’s nothing to choose for it.
        </p>
        <ol>
          <li>
            Sign up, then <strong>Create a server</strong>.
          </li>
          <li>Pick what to play.</li>
          <li>
            Type a name, then press <strong>Create server</strong>.
          </li>
          <li>Send everyone the address on the server’s page.</li>
        </ol>
        <Shot
          src={`${PICTURES}/what-to-play.png`}
          width={680}
          height={340}
          alt="The “What to play” question on the create page, with Survival picked, next to Creative, Hardcore and More ways to play. Under them: Cubepals picked Minecraft 26.2, the newest Bedrock friends can join. Players on Minecraft 1.9 or newer can join."
          caption="Cubepals picks the Minecraft Bedrock friends can join."
        />
        <Shot
          src={`${PICTURES}/name-it.png`}
          width={680}
          height={278}
          alt="The “Name it” question with the server name Copper Cove typed in. Under it: Friends join at copper-cove.play.cubepals.com. The bar below says Survival, Minecraft 26.2, Europe, and Up to 5 players, and has the Create server button."
        />
      </Part>

      <Part id="how-they-join" title="How your friends join">
        <p>
          On a phone, a tablet or Windows, Bedrock friends open <strong>Play</strong>, then{' '}
          <strong>Servers</strong>, then <strong>Add Server</strong>, and type the address. Java friends open{' '}
          <strong>Multiplayer</strong>, then <strong>Add Server</strong>, and paste the same one.
        </p>
        <Shot
          src={`${PICTURES}/address.png`}
          width={576}
          height={234}
          alt="A server’s page showing Copper Cove Online, its address copper-cove.play.cubepals.com with a Copy address button, and the lines: In Minecraft: Java Edition 1.9 or newer, open Multiplayer, then Add Server, and paste it. On a phone or tablet: Play, Servers, Add Server, and type the same address. Consoles can’t join."
        />
        <p>Xbox, PlayStation and Switch can’t add a server, so they can’t join.</p>
      </Part>

      <Part id="sleeps" title="It sleeps when nobody plays">
        <p>
          Nobody has to start it for anyone. When a friend joins, on Java or Bedrock, it wakes, and when
          everyone has gone it goes back to sleep. You don’t need to be online, and your computer doesn’t need
          to be on. <GuideLink to="minecraft-server-that-sleeps">How the sleeping works</GuideLink>.
        </p>
      </Part>

      <Part id="not-yet" title="Where Bedrock friends can’t join yet">
        <p>A server with mods or a modpack is for Java friends only for now.</p>
      </Part>
    </>
  )
}

/** Cubepals, where Bedrock is off: what it is today, and that Bedrock is coming. */
function ComingSoon() {
  return (
    <Part id="cubepals" title="On Cubepals">
      <p>
        Cubepals runs Minecraft: Java Edition today. Bedrock is coming soon, so friends on phones, tablets and
        Windows can join the same server as Java friends. Until then,{' '}
        <GuideLink to="minecraft-server-for-friends">making a server for friends</GuideLink> shows how a Java
        server goes.
      </p>
    </Part>
  )
}

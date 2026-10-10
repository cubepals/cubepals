// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The guide to how much RAM a Minecraft server needs. What decides memory comes from the Minecraft
 * Wiki; the sizes Cubepals runs are rendered from PARTY in the control plane's size.ts through
 * /api/public/sizes, below the fold, so they can't drift.
 */
import type { PartySize } from '@blockly/contracts'
import type { Metadata } from 'next'
import { publicSizes } from '../../../../lib/plans'
import { FactTable, GuideArticle, GuideLink, guideMetadata, Part, Questions, Shot } from '../article'

const SLUG = 'minecraft-server-ram'
const PICTURES = `/guides/${SLUG}`

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

/** "Who's playing" as the create page says each answer. */
const ASKED: Record<PartySize, string> = { '5': 'Up to 5', '10': 'Up to 10', '20': 'Up to 20', more: 'More' }

export default async function Guide() {
  // Kept five minutes, as the plans are: the sizes seldom change.
  const sizes = await publicSizes(300)
  const memoryFor = (party: PartySize) => sizes.find((size) => size.party === party)?.memory
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        It depends on how many people play at once, how far they can see, and whether the server runs mods.
        For a group of friends on Minecraft: Java Edition, it shouldn’t be something you have to work out at
        all.
      </p>

      <Part id="what-uses-memory" title="What uses memory">
        <ul>
          <li>
            <strong>Players.</strong> Each player keeps the part of the world around them loaded, so more
            players spread out means more of the world held at once.
          </li>
          <li>
            <strong>View distance.</strong> How much of the world the server sends each player, counted in
            chunks in every direction. The game’s default is 10.
          </li>
          <li>
            <strong>Simulation distance.</strong> How far from each player animals, machines and crops keep
            moving. Its default is 10 too.
          </li>
          <li>
            <strong>Mods and modpacks.</strong> Every mod adds its own blocks, creatures and work for the
            server, and a big pack adds hundreds.
          </li>
        </ul>
        <p>
          The <a href="https://minecraft.wiki/w/Server.properties">Minecraft Wiki’s server.properties page</a>{' '}
          explains both distances, and its server tutorial suggests at least 2 GB of memory to start, and
          possibly 4 GB for larger servers.
        </p>
      </Part>

      <Part id="why-cubepals-doesnt-ask" title="Why Cubepals doesn’t ask">
        <p>
          When you make a server, Cubepals asks <strong>Who’s playing</strong>: how many friends play at once.
          Bigger groups get a bigger server. That answer, and what you chose to play, decide its size. You
          never pick RAM.
        </p>
        <Shot
          src={`${PICTURES}/whos-playing.png`}
          width={680}
          height={184}
          alt="The Who’s playing question on the create page, with four choices: Up to 5, Up to 10 (picked), Up to 20 and More. Under it: How many friends play at once. Bigger groups get a bigger server."
        />
        <p>
          If your group grows, change it later under the server’s <strong>Settings</strong>, in{' '}
          <strong>Size</strong>.
        </p>
        <Shot
          src={`${PICTURES}/size.png`}
          width={576}
          height={357}
          alt="The Size card in a server’s settings: How many play at the same time. Bigger servers keep up with more players and bigger builds. Choices Up to 5, Up to 10, Up to 20 and More, and a Change size button."
        />
      </Part>

      <Part id="big-modpacks" title="Big modpacks">
        <p>
          Big modpacks and groups of 20 or more run on a large server, which counts two hours for each hour it
          runs. <GuideLink to="minecraft-server-cost">What a server costs</GuideLink> explains how hours work,
          and <GuideLink to="play-a-modpack-with-friends">playing a modpack with friends</GuideLink> covers
          the rest.
        </p>
      </Part>

      {sizes.length > 0 && (
        <Part id="what-cubepals-runs" title="What Cubepals actually runs">
          <p>For anyone curious, these are the sizes behind each answer to Who’s playing:</p>
          <FactTable
            head={['Who’s playing', 'Players at once', 'Memory']}
            rows={sizes.map((size) => [ASKED[size.party], `Up to ${size.maxPlayers}`, size.memory])}
          />
        </Part>
      )}

      <Questions
        items={[
          {
            question: 'How much RAM for 2, 5 or 10 players?',
            answer:
              memoryFor('5') && memoryFor('10')
                ? `On Cubepals, up to 5 players get ${memoryFor('5')} and up to 10 get ${memoryFor('10')}, picked for you from Who’s playing.`
                : 'On Cubepals it’s picked for you from Who’s playing, so you never have to work it out.',
          },
          {
            question: 'Can I give it more memory?',
            answer:
              'Pick a bigger answer to Who’s playing, in the server’s Settings under Size. Bigger sizes need a bigger plan.',
          },
          {
            question: 'Does the server need more for mods?',
            answer:
              'Usually, yes, and Cubepals sizes a modded server for what you chose to play, so a big pack gets a large server.',
          },
        ]}
      />
    </GuideArticle>
  )
}

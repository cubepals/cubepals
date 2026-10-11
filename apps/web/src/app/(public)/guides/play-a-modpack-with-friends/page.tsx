// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The guide to playing a modpack with your friends. The steps were done on a local stack, with the
 * Create setup on Plus, and the pictures are from that run.
 * Create, Modrinth and CurseForge are described from their own pages, linked where named.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { GuideArticle, GuideLink, guideMetadata, guidePlans, Part, Questions, Shot } from '../article'

const SLUG = 'play-a-modpack-with-friends'
const PICTURES = `/guides/${SLUG}`

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default async function Guide() {
  const { paid } = await guidePlans()
  const plus = paid?.name ?? 'Plus'
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        A modpack is a set of mods someone has put together to play as one game. Playing one with friends on
        Minecraft: Java Edition takes a server running the same pack. On Cubepals you pick the pack and it
        installs all of it. Mods and modpacks come with {plus}.
      </p>

      <Part id="what-it-needs" title="What a modpack server needs">
        <ul>
          <li>
            <strong>The same pack and version for everyone.</strong> Each friend’s game needs the pack the
            server runs, at the same version, on the same Minecraft version.
          </li>
          <li>
            <strong>A mod loader.</strong> Packs are built on one, such as NeoForge, Forge or Fabric, and the
            server runs the same one.
          </li>
          <li>
            <strong>Enough room.</strong> A pack with hundreds of mods asks a lot more of a server than plain
            Minecraft.
          </li>
        </ul>
        <p>
          On Cubepals, the first two follow from the pack you pick, and the third from what it is and who’s
          playing.
        </p>
      </Part>

      <Part id="picking" title="Picking a pack">
        <p>
          On the create page, under <strong>What to play</strong>, choose <strong>A modpack</strong>. Search
          Modrinth by name, or paste a link to a pack, or pick from the ones most people are playing. Cubepals
          installs the whole thing: mods, settings and all.
        </p>
        <Shot
          src={`${PICTURES}/search.png`}
          width={696}
          height={285}
          alt="The modpack search on the create page: a Search modpacks field, and the line: Packs published on Modrinth, by name or by a link to one. Cubepals installs the whole thing: mods, settings and all."
        />
        <p>
          For machines and contraptions, there’s a ready setup: <strong>Create</strong>, “Machines, gears and
          contraptions, with the Create mod ready to go.” The{' '}
          <a href="https://modrinth.com/mod/create">Create mod</a> calls itself “a mod offering a variety of
          tools and blocks for Building, Decoration and Aesthetic Automation.” Skyblock has a card of its own,
          and friends join it with plain Minecraft:{' '}
          <GuideLink to="lifesteal-manhunt-skyblock-with-friends">
            how to play Skyblock with friends
          </GuideLink>
          .
        </p>
        <Shot
          src={`${PICTURES}/create.png`}
          width={680}
          height={458}
          alt="The game modes under More ways to play, with Create picked: Machines, gears and contraptions, with the Create mod ready to go."
        />
      </Part>

      <Part id="friends-side" title="Your friends’ side">
        <p>
          Your friends install the same pack in their own game, with a launcher that installs Modrinth packs.
          The invite link you send them says exactly what they need first, before anything else.
        </p>
        <Shot
          src={`${PICTURES}/what-you-need.png`}
          width={576}
          height={208}
          alt="The What you need first card on an invite: NeoForge 21.1.256 for Minecraft 1.21.1, and these in your own game, with a link to Create."
          caption="What the invite to a Create server said a friend needs."
        />
      </Part>

      <Part id="curseforge" title="A pack from CurseForge">
        <p>
          Cubepals can’t install straight from CurseForge. A pack from CurseForge or a launcher runs from its
          file instead: download its server pack, or export it, and drop it in with{' '}
          <strong>A pack you have</strong>. On CurseForge, a pack’s server files are among its{' '}
          <a href="https://support.curseforge.com/support/solutions/articles/9000197242-file-project-types-and-additional-fields">
            additional files
          </a>
          .
        </p>
      </Part>

      <Part id="big-packs" title="Big packs">
        <p>
          Big modpacks run on a large server, which counts two hours for each hour it runs. You don’t choose
          its memory: <GuideLink to="minecraft-server-ram">how much memory a server needs</GuideLink> explains
          why.
        </p>
      </Part>

      <Questions
        items={[
          {
            question: 'Do I need Plus for mods?',
            answer: (
              <>
                Yes. Mods, plugins and modpacks come with {plus}; <Link href="/pricing">Pricing</Link> has
                what each plan includes.
              </>
            ),
          },
          {
            question: 'Can friends join without the pack?',
            answer:
              'Not to a modded server. Each of them needs the same pack, at the same version, in their own game.',
          },
          {
            question: 'Can I add mods myself?',
            answer:
              'Yes. Under What to play, “Picking mods yourself?” starts a server on a mod loader, and the server’s Mods page adds mods to it.',
          },
          {
            question: 'Where do I start?',
            answer: (
              <>
                <GuideLink to="minecraft-server-for-friends">Making a server for friends</GuideLink> goes
                through the create page from the top.
              </>
            ),
          },
        ]}
      />
    </GuideArticle>
  )
}

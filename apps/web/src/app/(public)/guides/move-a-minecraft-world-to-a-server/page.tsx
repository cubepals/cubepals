// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The guide to moving a world a player already has to a Cubepals server: from single-player, from
 * another host or a server's folder, and with mods (docs/world-import.md). The steps follow the
 * create page's "Your own world" and a server's Backups page, and the saves folders are the ones
 * the drop target names. The pictures are from a local stack.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { GuideArticle, GuideLink, guideMetadata, guidePlans, Part, Questions, Shot } from '../article'

const SLUG = 'move-a-minecraft-world-to-a-server'
const PICTURES = `/guides/${SLUG}`

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default async function Guide() {
  const { paid } = await guidePlans()
  const plus = paid?.name ?? 'Plus'
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        A world you built in single-player, or on a server somewhere else, can carry on as a server your
        friends join. On Cubepals you hand over the world as it is, a folder or a zip, and the server is made
        to fit it: the same Minecraft, the same game mode and difficulty, its name and its seed. For
        Minecraft: Java Edition.
      </p>

      <Part id="single-player" title="From single-player">
        <ol>
          <li>Close the world in Minecraft, so nothing is still writing to it.</li>
          <li>
            On the create page, choose <strong>Your own world</strong>.
          </li>
          <li>
            Drop the world’s folder, or a zip of it, or use <strong>Choose a folder</strong>. Minecraft keeps
            single-player worlds in <code>%APPDATA%\.minecraft\saves</code> on Windows,{' '}
            <code>~/Library/Application Support/minecraft/saves</code> on macOS and{' '}
            <code>~/.minecraft/saves</code> on Linux. The page shows the one for your computer.
          </li>
          <li>
            Say which Minecraft account played it. In single-player, what you carry and where you stand are
            kept in the world itself, and Cubepals gives them to that account on the server, so you arrive
            with your things.
          </li>
          <li>
            Choose <strong>Make a server with it</strong>, then who’s playing and a name, as for any server.
          </li>
        </ol>
        <Shot
          src={`${PICTURES}/drop.png`}
          width={710}
          height={241}
          alt="The drop on the create page’s Your own world: Drop the world’s folder here, or its zip, with Choose a folder and Choose a zip buttons. Below it: On Windows, Minecraft keeps single-player worlds in %APPDATA%\.minecraft\saves, with a Copy button."
        />
        <Shot
          src={`${PICTURES}/who-played.png`}
          width={710}
          height={226}
          alt="This is a single-player world. Who played it? What they carried and where they stood go to that Minecraft account on the server. A Minecraft name field with Steve typed in, a Continue button, and Nobody, just the world."
        />
        <Shot
          src={`${PICTURES}/ready.png`}
          width={710}
          height={224}
          alt="The world read: Gave Steve what they carried and where they stood in the single-player world. Under it, the world Maple Hollow, Minecraft 26.3, picked, and a Make a server with it button."
          caption="What Cubepals did with the world is said above it, before anything is made."
        />
      </Part>

      <Part id="another-host" title="From another host or a server’s folder">
        <p>
          Download your server’s files from the host you’re leaving, as a zip, and drop it in the same way.
          Cubepals finds the world its <code>server.properties</code> names, with its Nether and End, whether
          the server kept them inside the world or beside it, as Paper does.
        </p>
        <ul>
          <li>
            <strong>Who could join comes with it.</strong> Its whitelist, operators and bans are listed, and
            you choose who comes along. Nobody is let in until you say, and the server starts open to anyone.
            Turn on its whitelist to let in only the players you chose. Its bans come unless you say not.
          </li>
          <li>
            <strong>Players on an offline-mode server keep their things.</strong> Such a server names each
            player’s files by a made-up ID. Cubepals looks each name up as a Minecraft account and moves their
            inventory, stats and advancements to it. A name no account has is said, and its files stay.
          </li>
          <li>
            <strong>What isn’t the world is left out,</strong> such as the server’s jar and its logs, and the
            page lists what was.
          </li>
        </ul>
        <Shot
          src={`${PICTURES}/who-can-join.png`}
          width={710}
          height={242}
          alt="Who can join, read from a server’s folder: Its server let these 2 players in. Choose who comes here too; nobody does until you say. Steve, with Operator and Let in turned on, and Alex, with Let in turned on. Under them, Only players let in can join is on, and Keep its ban: Herobrine is on."
        />
      </Part>

      <Part id="mods" title="A world played with mods">
        <p>
          A world played with mods only opens whole on a server running the same mods: plain Minecraft would
          lose their blocks and items. Cubepals can tell from the world, and asks for the pack it was played
          with. Find it by name, or drop its file, and the server is made from that pack, starting on your
          world. A server’s folder or a launcher’s export that has its mods in it is read as both: the pack
          and the world, from one file. Mods and modpacks come with {plus};{' '}
          <GuideLink to="play-a-modpack-with-friends">playing a modpack with friends</GuideLink> covers the
          rest.
        </p>
        <Shot
          src={`${PICTURES}/mods.png`}
          width={710}
          height={304}
          alt="The world Cog Valley, Minecraft 26.3, and under it: It was played with Fabric mods. Plain Minecraft would lose their blocks and items, so its server is made from the pack it was played with. Find the pack, or drop its file. A Search modpacks field follows, for packs published on Modrinth."
        />
      </Part>

      <Part id="existing-server" title="Into a server you already have">
        <p>
          On a server’s <strong>Backups</strong> page, <strong>Upload a world</strong> keeps the world as a
          backup of that server. Restoring it is the next step, and the world the server has now is backed up
          first. A server’s folder holding more than one world, as servers with several worlds do, has each
          one kept as its own backup. Made into a new server, it starts on the world its{' '}
          <code>server.properties</code> names; upload the same file on its Backups page to keep the others.
        </p>
        <Shot
          src={`${PICTURES}/backups.png`}
          width={478}
          height={302}
          alt="Bring a world, after a server’s folder is uploaded on the Backups page: It’s kept as a backup of this server. Restore it to play it; the world it has now is backed up first. The notes list what was left out, say it was last played on Minecraft 1.21.11 and that restoring it opens it on 26.2, name its folder on the server, and say Also kept creative, the server’s other world, as a backup to restore when you want to play it."
        />
      </Part>

      <Part id="versions" title="Which Minecraft it runs">
        <p>
          The server runs the Minecraft the world was last played on. Where Cubepals doesn’t offer that one,
          it runs the next one it does, and says so. Opening a world on a newer Minecraft updates it, which
          can’t be undone. A world from a newer Minecraft than any Cubepals offers, or from before 1.9, isn’t
          opened, and the page says why.
        </p>
      </Part>

      <Questions
        items={[
          {
            question: 'How big can the world be?',
            answer:
              'Up to 4 GB as you upload it, and it has to fit on the server once unpacked. The page says so before anything is made if it won’t.',
          },
          {
            question: 'Can I bring a Bedrock world?',
            answer: 'No. A Cubepals server plays Java worlds, and can’t open a Bedrock save.',
          },
          {
            question: 'Is my upload kept?',
            answer:
              'On a server you have, the world is kept as a backup of it. For a new server, it’s kept for a month while you make the server.',
          },
          {
            question: 'Where do I start?',
            answer: (
              <>
                On the <Link href="/servers/new">create page</Link>.{' '}
                <GuideLink to="minecraft-server-for-friends">Making a server for friends</GuideLink> goes
                through it from the top.
              </>
            ),
          },
        ]}
      />
    </GuideArticle>
  )
}

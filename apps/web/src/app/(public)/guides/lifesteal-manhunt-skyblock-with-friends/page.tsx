/**
 * The guide to Lifesteal, Manhunt and Skyblock with friends. Each was made from its card on a
 * local stack, on Plus, and played with test players: a heart taken and a player eliminated and
 * revived (LifeStealZ 2.21.1), a hunt started and won (Manhunt+ 1.4.2), and the island SkyBlock
 * Plus 1.0.9 starts you on. The pictures are from that run. What each mode is comes from its own
 * page and files, linked where named; the price from the plan table.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { priceOf } from '../../../../ui'
import { GuideArticle, GuideLink, guideMetadata, guidePlans, Part, Questions, Shot } from '../article'

const SLUG = 'lifesteal-manhunt-skyblock-with-friends'
const PICTURES = `/guides/${SLUG}`

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default async function Guide() {
  const { paid } = await guidePlans()
  const plus = paid?.name ?? 'Plus'
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        Lifesteal, Manhunt and Skyblock are three ways to play Minecraft: Java Edition with friends that need
        nothing but a server: no map to build, and nothing for your friends to install. On Cubepals each one
        is a card under <strong>What to play</strong>. Lifesteal and Manhunt run a plugin and Skyblock is a
        modpack, so all three come with {plus}
        {paid ? `, ${priceOf(paid.monthlyPriceCents)} with ${paid.includedHours} hours of play` : ''}.
      </p>

      <Part id="starting" title="Starting one">
        <p>
          On the create page, under <strong>What to play</strong>, pick <strong>Lifesteal</strong>,{' '}
          <strong>Manhunt</strong> or <strong>Skyblock</strong>, then say who’s playing and name it. Cubepals
          picks the Minecraft version everything in it runs on, and says so. Your friends join with plain
          Minecraft at that version.
        </p>
        <Shot
          src={`${PICTURES}/what-to-play.png`}
          width={680}
          height={455}
          alt="The What to play question with Lifesteal picked, next to Manhunt and Skyblock. Under it: Cubepals picked Minecraft 26.2, the newest that everything in Lifesteal runs on."
        />
      </Part>

      <Part id="lifesteal" title="Lifesteal">
        <p>
          Everyone starts with 10 hearts. Kill another player and you take one of theirs; die any other way
          and you lose one. Run out and you’re eliminated: the server won’t let you back in. It runs{' '}
          <a href="https://modrinth.com/plugin/lifestealz">LifeStealZ</a> on its own settings, where nobody
          holds more than 20 hearts.
        </p>
        <ul>
          <li>
            <code>/hearts</code> says how many you have.
          </li>
          <li>
            <code>/withdrawheart</code> turns one of yours into a Heart you can hand to a friend. Hearts can
            be crafted too.
          </li>
          <li>
            To bring someone back, craft a Revive Beacon in the game, or have an operator type{' '}
            <code>/revive</code> and their name. They come back with one heart.
          </li>
        </ul>
        <p>Hearts belong to players, not to the world, so a new world doesn’t give them back.</p>
      </Part>

      <Part id="manhunt" title="Manhunt">
        <p>
          One of you is the speedrunner, who tries to beat the{' '}
          <a href="https://minecraft.wiki/w/Ender_Dragon">Ender Dragon</a>. Everyone else hunts them, with a
          compass that points to the runner. The runner wins when the dragon dies, and the hunters win when
          the runner does. It runs <a href="https://modrinth.com/plugin/manhunt+">Manhunt+</a>.
        </p>
        <p>A hunt takes an evening, so a Manhunt server starts out as one that lasts a day.</p>
        <Shot
          src={`${PICTURES}/for-a-day.png`}
          width={680}
          height={106}
          alt="Just for a day, switched on, and under it: Manhunt is played in an evening, so this one lasts a day. Cubepals deletes it 24 hours from now. Its world goes to the trash, and one press keeps it instead."
        />
        <p>
          Whoever runs the hunt needs to be an operator. On the server’s <strong>Players</strong> page, under{' '}
          <strong>Operators</strong>, type their Minecraft name in <strong>Make someone an operator</strong>.
        </p>
        <Shot
          src={`${PICTURES}/operators.png`}
          width={560}
          height={236}
          alt="The Operators card on the Players page: Operators can use every command in the game and join even when the server is full. A Make someone an operator field and an Add button."
        />
        <p>Then, in the game:</p>
        <ol>
          <li>
            <code>/manhunt speedrunner add</code> and the runner’s name.
          </li>
          <li>
            <code>/manhunt hunter add</code> and each hunter’s name.
          </li>
          <li>
            <code>/manhunt start</code>. Each hunter gets their compass with <code>/compass</code> and the
            runner’s name.
          </li>
        </ol>
        <p>
          For another round on fresh ground, open the server’s <strong>World</strong> page and use{' '}
          <strong>Start a new world</strong>. The old one stays, and you pick the runner and hunters again.
        </p>
      </Part>

      <Part id="skyblock" title="Skyblock">
        <p>
          You start on one small island over the void: some dirt and grass, an oak tree, and a chest with an
          ice block and a bucket of lava. Everything else you make from that. It runs{' '}
          <a href="https://modrinth.com/modpack/skyblock-plus">SkyBlock Plus</a>, whose advancements are
          rearranged to hint at what to try next, such as a cobblestone generator. There’s a Nether island
          too.
        </p>
        <p>
          SkyBlock Plus only changes the server, so friends join with plain Minecraft, and everyone starts on
          the same island.
        </p>
      </Part>

      <Questions
        items={[
          {
            question: 'Do my friends need to install anything?',
            answer:
              'No. All three run on the server alone, and friends join with plain Minecraft: Java Edition, on the version the server’s page names.',
          },
          {
            question: 'Can we change the rules?',
            answer:
              'Not from Cubepals yet. Each one plays on its own settings: in Lifesteal, 10 hearts to start and 20 at most.',
          },
          {
            question: 'Does it work on Bedrock or consoles?',
            answer:
              'Not yet. Cubepals runs Minecraft: Java Edition, and Bedrock players can’t join a Java server.',
          },
          {
            question: 'Where do I start?',
            answer: (
              <>
                <GuideLink to="minecraft-server-for-friends">Making a server for friends</GuideLink> goes
                through the create page from the top, and <Link href="/pricing">Pricing</Link> has what {plus}{' '}
                includes.
              </>
            ),
          },
        ]}
      />
    </GuideArticle>
  )
}

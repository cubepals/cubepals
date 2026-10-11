// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The guide to a Minecraft server for friends in the UK and Europe. Where servers run is
 * production's region map (infra/terraform/environments/production, eu:fra and us:iad), and Fly's
 * region list says where those are; how a region is picked is lib/nearest-region.ts. No ping
 * figures: none is measured from those places yet.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { GuideArticle, GuideLink, guideMetadata, Part, Questions, Shot } from '../article'

const SLUG = 'minecraft-server-uk-europe'
const PICTURES = `/guides/${SLUG}`

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default function Guide() {
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        Cubepals’ servers for Europe are in Frankfurt, in Germany. There isn’t one in the UK. For North
        America, they’re in Virginia, in the US. This guide is for groups on Minecraft: Java Edition deciding
        where their world should live.
      </p>

      <Part id="where" title="Where your server runs">
        <p>
          You don’t have to pick. When you make a server, Cubepals starts it in the region nearest you, from
          the country you’re in: Europe for the UK, Ireland, the Netherlands, the Nordics and the rest of
          Europe, and North America for the US and Canada. The bar at the bottom of the create page says
          which, and pressing it lets you choose the other.
        </p>
        <Shot
          src={`${PICTURES}/bar.png`}
          width={696}
          height={88}
          alt="The bar at the bottom of the create page: Maple Hollow, Survival, Minecraft 26.3, Europe, closest to you, Up to 5 players, and the Create server button."
        />
        <p>
          The regions are run on <a href="https://docs.fly.io/reference/regions">Fly.io</a>, whose region list
          puts Europe’s, “fra”, in Frankfurt, Germany, and North America’s, “iad”, in Ashburn, Virginia. For a
          group spread around Europe, Frankfurt is central: closer to your players means less lag.
        </p>
      </Part>

      <Part id="mixed-group" title="Friends in the US and Europe in one group">
        <p>
          A server runs in one place, so someone in a mixed group is further from it than the rest. It starts
          where the person making it is. If most of the group is on the other side of the Atlantic, pick their
          region in the bar instead, or move it later: in the server’s <strong>Settings</strong>, under{' '}
          <strong>Location</strong>, choose the <strong>Region</strong> and press <strong>Move server</strong>
          .
        </p>
        <Shot
          src={`${PICTURES}/location.png`}
          width={576}
          height={315}
          alt="The Location card in a server’s settings: Where your world lives. Closer to your players means less lag. A Region menu set to Europe, and a Move server button."
        />
      </Part>

      <Part id="prices" title="Prices">
        <p>
          Prices are in US dollars and include VAT where it applies. The plans and what each includes are on{' '}
          <Link href="/pricing">Pricing</Link>, and{' '}
          <GuideLink to="minecraft-server-cost">what a server costs</GuideLink> explains how hours work.
        </p>
      </Part>

      <Questions
        items={[
          {
            question: 'Is there a UK server?',
            answer: 'No. Players in the UK and Ireland start in Europe, which is Frankfurt.',
          },
          {
            question: 'Can I change the region after making it?',
            answer: 'Yes: Settings, then Location, then Move server. The world moves with it.',
          },
          {
            question: 'How do my friends join?',
            answer: (
              <>
                The same way wherever the server is: Multiplayer, then Add Server, and paste the address.{' '}
                <GuideLink to="minecraft-server-for-friends">Making a server for friends</GuideLink> shows it
                step by step.
              </>
            ),
          },
        ]}
      />
    </GuideArticle>
  )
}

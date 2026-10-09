/**
 * The guides: each one's address, title, description and dates, and whether it has passed review.
 * This list decides where a guide appears. While a guide is unapproved it can be read locally and
 * in previews, says noindex, and is left out of the sitemap, the /guides index and the footers; in
 * production it is a 404. A reviewed guide is published by setting `approved: true` and its
 * `published` date to the day it goes up.
 *
 * Each guide's words are in its own directory under guides/, one `page.tsx` each, and the pictures
 * in it are under `public/guides/<slug>/`, taken on a local stack.
 *
 * Parts (`guides/`):
 * - `page.tsx`: the /guides index, listing the guides that are live
 * - `article.tsx`: what every guide page is made of: its frame, pictures, questions and markup
 * - `links.tsx`: the guides the footers link to, as links
 */
import { notFound } from 'next/navigation'
import { indexable } from '../../lib/site'

export interface Guide {
  slug: string
  /** The page's H1 and tab title, before "· Cubepals". */
  title: string
  /** Under 155 characters, so search results don't cut it. */
  description: string
  /** The day it went up and the day it last changed, as YYYY-MM-DD: shown on the page and in its markup. */
  published: string
  modified: string
  approved: boolean
}

export const GUIDES: readonly Guide[] = [
  {
    slug: 'minecraft-server-for-friends',
    title: 'How to make a Minecraft server for friends',
    description:
      'Make a Minecraft server for you and your friends in three decisions: what to play, who’s playing, and a name. Free to start. For Java Edition.',
    published: '2026-10-07',
    modified: '2026-10-07',
    approved: false,
  },
  {
    slug: 'play-minecraft-java-with-friends',
    title: 'How to play Minecraft: Java Edition with friends',
    description:
      'The ways to play Minecraft: Java Edition with friends, on the same Wi-Fi or far apart, and which one lets them play when you’re not on.',
    published: '2026-10-07',
    modified: '2026-10-07',
    approved: false,
  },
  {
    slug: 'minecraft-server-cost',
    title: 'How much does a Minecraft server cost?',
    description:
      'What a Minecraft server for friends costs, and why you shouldn’t pay for hours nobody plays. Cubepals is free to start.',
    published: '2026-10-07',
    modified: '2026-10-07',
    approved: false,
  },
  {
    slug: 'minecraft-server-that-sleeps',
    title: 'A Minecraft server that sleeps when nobody plays',
    description:
      'Why a Minecraft server should sleep when nobody’s on, what your friends see when they join a sleeping one, and what happens to the world.',
    published: '2026-10-07',
    modified: '2026-10-07',
    approved: false,
  },
  {
    slug: 'minecraft-server-ram',
    title: 'How much RAM does a Minecraft server need?',
    description:
      'What decides how much memory a Minecraft server needs, and why on Cubepals you never pick it: you say who’s playing, and it’s sized for you.',
    published: '2026-10-07',
    modified: '2026-10-07',
    approved: false,
  },
  {
    slug: 'minecraft-server-without-port-forwarding',
    title: 'How to host a Minecraft server without port forwarding',
    description:
      'Why port forwarding is so often the step that stops friends joining, the ways around it, and a server with one address and nothing to open.',
    published: '2026-10-07',
    modified: '2026-10-07',
    approved: false,
  },
  {
    slug: 'play-a-modpack-with-friends',
    title: 'How to play a modpack with your friends',
    description:
      'Play a Minecraft modpack with your friends without installing a server: pick a pack from Modrinth and Cubepals installs all of it. With Plus.',
    published: '2026-10-07',
    modified: '2026-10-07',
    approved: false,
  },
  {
    slug: 'minecraft-server-uk-europe',
    title: 'A Minecraft server for friends in the UK and Europe',
    description:
      'Cubepals runs servers in Frankfurt for friends in the UK, Ireland, the Netherlands, the Nordics and the rest of Europe, and in Virginia for the US.',
    published: '2026-10-07',
    modified: '2026-10-07',
    approved: false,
  },
]

/** The guides the footers link to: the first how-to guides, never a comparison. */
const IN_FOOTERS = [
  'minecraft-server-for-friends',
  'minecraft-server-cost',
  'minecraft-server-that-sleeps',
  'minecraft-server-uk-europe',
]

export const guideHref = (guide: Pick<Guide, 'slug'>): string => `/guides/${guide.slug}`

/** The guides the public sees: approved ones, wherever the site runs. */
export const publishedGuides = (): Guide[] => GUIDES.filter((guide) => guide.approved)

/** Guides waiting for review, readable everywhere but production. */
export const draftGuides = (): Guide[] => (indexable() ? [] : GUIDES.filter((guide) => !guide.approved))

/** The approved guides the footers link to, in their order. */
export const footerGuides = (): Guide[] =>
  publishedGuides().filter((guide) => IN_FOOTERS.includes(guide.slug))

/** Whether /guides has anything to show here: in production, only once a guide is approved. */
export const guidesIndexLive = (): boolean => publishedGuides().length > 0 || !indexable()

/** A guide by its address, or a 404 where it isn't live: unapproved, in production. */
export function liveGuide(slug: string): Guide {
  const guide = GUIDES.find((candidate) => candidate.slug === slug)
  if (guide === undefined || (!guide.approved && indexable())) notFound()
  return guide
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the site lives, whether search engines may index this deployment of it, and what a page
 * tells them about itself. Not for structured data, which is structured-data.tsx.
 */
import type { Metadata } from 'next'

/**
 * Where the site lives, and whether search engines may index this deployment of it. Indexing is
 * off unless the deployment says otherwise, so a forgotten setting hides a staging copy rather
 * than exposing one: only production sets WEB_INDEXABLE=1.
 */
export const canonicalOrigin = (): string =>
  (process.env.WEB_CANONICAL_ORIGIN ?? 'https://cubepals.com').replace(/\/$/, '')
export const indexable = (): boolean => process.env.WEB_INDEXABLE === '1'

/** Pages that are no use to land on from a search, though their links are worth following. */
export const UNLISTED: NonNullable<Metadata['robots']> = { index: false, follow: true }
/** Pages that are private by design, like an invite: neither listed nor followed. */
export const PRIVATE: NonNullable<Metadata['robots']> = { index: false, follow: false }

/**
 * The site-wide link preview, `app/opengraph-image.png`. A page that sets its own Open Graph
 * replaces the root's whole object, picture included, so it names the picture again.
 */
const SHARE_IMAGE = {
  url: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: 'Cubepals: a Minecraft server that starts when your friends join',
}

/**
 * A page's own title, description and address, carried into its link previews too: Next merges
 * metadata shallowly, so a page that set only its title would preview with the home page's words.
 * The title is as the tab shows it, before the layout adds "· Cubepals".
 */
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string
  description: string
  path: string
}): Metadata {
  const full = `${title} · Cubepals`
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      siteName: 'Cubepals',
      type: 'website',
      title: full,
      description,
      url: path,
      images: [SHARE_IMAGE],
    },
    twitter: { card: 'summary_large_image', title: full, description, images: [SHARE_IMAGE] },
  }
}

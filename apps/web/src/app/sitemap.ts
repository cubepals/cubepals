// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { TERMS_VERSION } from '@blockly/contracts'
import type { MetadataRoute } from 'next'
import { hrefOf, POLICIES } from '../legal/policies'
import { canonicalOrigin } from '../lib/site'
import { guideHref, publishedGuides } from './(public)/guides'

/**
 * The pages worth finding: home, pricing, the approved guides, and the policies.
 * A date appears only where the page has a real one. Left out on purpose: /browse and public
 * server pages (noindex for now), sign-in and the other auth pages, invites, and the app.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const at = (path: string) => `${canonicalOrigin()}${path}`
  const guides = publishedGuides()
  const newest = guides
    .map((guide) => guide.modified)
    .sort()
    .at(-1)
  return [
    { url: at('/') },
    { url: at('/pricing') },
    ...(newest ? [{ url: at('/guides'), lastModified: newest }] : []),
    ...guides.map((guide) => ({ url: at(guideHref(guide)), lastModified: guide.modified })),
    { url: at('/legal'), lastModified: TERMS_VERSION },
    ...POLICIES.map((policy) => ({ url: at(hrefOf(policy)), lastModified: TERMS_VERSION })),
  ]
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import { Frame, landingOf } from '../landing/Landing'
import { landingMetadata } from '../landing/metadata'
import { Page } from '../landing/Page'
import { bedrockLive } from '../lib/bedrock'

export const generateMetadata = () => landingMetadata(bedrockLive())

/**
 * The landing page: one page for every screen, scrolled as the browser scrolls it. Its sections are
 * landing/Page.tsx, and the design's rules landing/README.md.
 */
export default async function Landing({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const landed = await landingOf(searchParams)
  return (
    <Frame plans={landed.plans}>
      <Page {...landed} />
    </Frame>
  )
}

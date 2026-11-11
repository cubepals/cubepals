// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import { FilmPage } from '../landing/film/FilmPage'
import { Frame, landingOf } from '../landing/Landing'
import { Layouts } from '../landing/Layouts'
import { landingMetadata } from '../landing/metadata'
import { Phone } from '../landing/phone/Phone'
import { bedrockLive } from '../lib/bedrock'

export const generateMetadata = () => landingMetadata(bedrockLive())

/**
 * The landing page: a film the scroll plays, on one Minecraft chunk. One beat to a screen, the
 * picture the whole of it, one sentence each, and each beat's action played once as the page
 * comes to rest on it. Night; somebody types the address; under the grass the server wakes; day,
 * and the friends walk in; the two things it asks, and everything it didn't; everyone leaves and
 * it sleeps; then the dig, for the curious, through the rooms under the house; all the worlds;
 * what it costs; the button. What each beat claims is demonstrated one layer down, behind "How
 * it works". The design's rules are in landing/README.md.
 *
 * A narrow screen gets a short page of its own instead (landing/phone/Phone.tsx), and
 * landing/Layouts.tsx says which a screen gets. A phone is sent that page alone (app/phone).
 */
export default async function Landing({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const landed = await landingOf(searchParams)
  return (
    <Frame plans={landed.plans} film>
      <Layouts film={<FilmPage {...landed} />} page={<Phone {...landed} />} />
    </Frame>
  )
}

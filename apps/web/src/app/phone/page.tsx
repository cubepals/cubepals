// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import { Frame, landingOf } from '../../landing/Landing'
import { landingMetadata } from '../../landing/metadata'
import { Phone } from '../../landing/phone/Phone'
import { bedrockLive } from '../../lib/bedrock'

export const generateMetadata = () => landingMetadata(bedrockLive())

/**
 * The landing page as a phone is sent it: its own short page and nothing of the film, so none of
 * the film's code is loaded. A phone asking for `/` is shown this at that address (next.config.ts);
 * its canonical address is `/` all the same.
 */
export default async function PhoneLanding({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const landed = await landingOf(searchParams)
  return (
    <Frame plans={landed.plans}>
      <Phone {...landed} />
    </Frame>
  )
}

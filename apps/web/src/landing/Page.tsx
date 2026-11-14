// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The landing page, top to bottom, on one sheet the browser scrolls as it always does. The first
 * screen says what Cubepals is and plays it on the island; then how a server is made and joined,
 * what Cubepals does for it, what it costs, Cubepals' own servers to try, the questions people
 * ask, and the button once more. The design's rules are in README.md.
 */
import { SiteHeader } from '../app/(public)/header'
import type { Landed } from './Landing'
import { Asked } from './sections/Asked'
import { Closing } from './sections/Closing'
import { Handled } from './sections/Handled'
import { Opening } from './sections/Opening'
import { Ours } from './sections/Ours'
import { Pricing } from './sections/Pricing'
import { Steps } from './sections/Steps'

export function Page({ signedIn, create, plans, getPlan, arcade, ours, bedrock }: Landed) {
  const plus = plans.find((plan) => plan.mods)?.name ?? null
  return (
    <>
      <SiteHeader signedIn={signedIn} create={create} marks="nav" over />
      <main>
        <Opening create={create} plans={plans} arcade={arcade} bedrock={bedrock} />
        <Steps />
        <Handled bedrock={bedrock} plus={plus} />
        <Pricing plans={plans} create={create} getPlan={getPlan} bedrock={bedrock} />
        <Ours ours={ours} />
        <Asked plans={plans} />
        <Closing create={create} plans={plans} />
      </main>
    </>
  )
}

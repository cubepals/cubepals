// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What the landing page's two routes share: its title and description, what it reads (who is
 * signed in, where its buttons lead, the plans), and the frame its forms are set in (the type,
 * what reports the marks, the foot of the page and the structured data). `/` sets the film and the
 * phone's page in it (app/page.tsx); a phone, sent to `/phone` (next.config.ts), only the latter
 * (app/phone/page.tsx), so it never loads the film. Not the forms themselves.
 */
import type { PublicPlan } from '@blockly/contracts'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Presses } from '../app/(public)/presses'
import { publicPlans } from '../lib/plans'
import { currentSession } from '../lib/session'
import { canonicalOrigin } from '../lib/site'
import { sourceOf, withSource } from '../lib/source'
import { appSchema, JsonLd, siteSchema } from '../lib/structured-data'
import { aside, digits, display, pixel } from './fonts'
import { Footer } from './sections/Footer'
import './landing.css'

// "Minecraft" is what people search for and read first; it is never the first word of the name.
// One address for the page, however a link to it was tagged (`?utm_source=…`), and whichever form
// it was sent in.
const TITLE = 'Cubepals · Minecraft server hosting for friends'
const DESCRIPTION =
  'A Minecraft server that starts when your friends join. Free to start, no card needed. For Minecraft: Java Edition.'
export const LANDING_METADATA: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: { siteName: 'Cubepals', type: 'website', title: TITLE, description: DESCRIPTION, url: '/' },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
}

/** What either form of the page is given. */
export interface Landed {
  signedIn: boolean
  /** Where "Create a server" leads. */
  create: string
  plans: PublicPlan[]
  /** Where a paid plan's button leads, by plan key. */
  getPlan: (key: string) => string
}

/** What the page reads for whoever has landed, with the tags of the link they came by. */
export async function landingOf(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
): Promise<Landed> {
  const signedIn = (await currentSession()) !== null
  const source = sourceOf(await searchParams)
  const create = signedIn ? '/servers/new' : withSource('/sign-up', source)
  // Kept five minutes: one reading serves everyone who lands in that time.
  const plans = await publicPlans(300)
  const getPlan = (key: string) => {
    const account = `/account?get=${key}&reason=pricing`
    return signedIn ? account : withSource(`/sign-up?next=${encodeURIComponent(account)}`, source)
  }
  return { signedIn, create, plans, getPlan }
}

/** The frame the page's forms are set in. `film` marks the one the film is in. */
export function Frame({
  plans,
  film,
  children,
}: {
  plans: PublicPlan[]
  film?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={`bl ${display.variable} ${pixel.variable} ${digits.variable} ${aside.variable}`}
      data-landing
      data-film={film || undefined}
    >
      <Presses />
      {children}
      <Footer />
      <JsonLd schema={siteSchema(canonicalOrigin())} />
      <JsonLd schema={appSchema(plans, canonicalOrigin())} />
    </div>
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What the landing page's two routes share: what it reads (who is signed in, where its buttons
 * lead, the plans), and the frame its forms are set in (the type, what reports the marks, the foot
 * of the page and the structured data). `/` sets the film and the phone's page in it
 * (app/page.tsx); a phone, sent to `/phone` (next.config.ts), only the latter (app/phone/page.tsx),
 * so it never loads the film. Not the forms themselves, nor the title and description
 * (`metadata.ts`).
 */
import type { PublicPlan } from '@blockly/contracts'
import type { ReactNode } from 'react'
import { Presses } from '../app/(public)/presses'
import type { PublicStatus } from '../app/(public)/status'
import { bedrockLive } from '../lib/bedrock'
import { offeredPlans, publicPlans } from '../lib/plans'
import { currentSession } from '../lib/session'
import { canonicalOrigin } from '../lib/site'
import { sourceOf, withSource } from '../lib/source'
import { appSchema, JsonLd, siteSchema } from '../lib/structured-data'
import { apiUpstream, RENDER_READ_MS } from '../lib/upstream'
import { aside, digits, display, pixel } from './fonts'
import { Footer } from './sections/Footer'
import './landing.css'

/** What either form of the page is given. */
export interface Landed {
  signedIn: boolean
  /** Where "Create a server" leads. */
  create: string
  /** The plans as people choose on them: what a month of each charges now (`offeredPlans`). */
  plans: PublicPlan[]
  /** The plan table's own figures, for the structured data, which is kept longer than a minute. */
  table: PublicPlan[]
  /** Where a paid plan's button leads, by plan key, for a month or a year. */
  getPlan: (key: string, term?: 'month' | 'year') => string
  /** Cubepals' own Arcade as anyone can see it, or null unless it is known to be awake or asleep. */
  arcade: PublicStatus | null
  /** Whether the pages say Bedrock friends can join (lib/bedrock.ts). */
  bedrock: boolean
}

/** The Arcade's address on the public status endpoint. */
const ARCADE = 'arcade'

/**
 * The Arcade's public status, read on the server the way Browse reads a server's (status.ts), and
 * kept half a minute: the browser asks for nothing, so a server that isn't public costs it no
 * failed request. Null when it can't be read or the Arcade is neither awake nor asleep.
 */
async function arcadeNow(): Promise<PublicStatus | null> {
  try {
    const response = await fetch(`${apiUpstream()}/api/public/servers/${ARCADE}`, {
      signal: AbortSignal.timeout(RENDER_READ_MS),
      next: { revalidate: 30 },
    })
    if (!response.ok) return null
    const status = (await response.json()) as PublicStatus
    return status.state === 'awake' || status.state === 'asleep' ? status : null
  } catch {
    return null
  }
}

/** What the page reads for whoever has landed, with the tags of the link they came by. */
export async function landingOf(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
): Promise<Landed> {
  const signedIn = (await currentSession()) !== null
  const source = sourceOf(await searchParams)
  const create = signedIn ? '/servers/new' : withSource('/sign-up', source)
  // Kept five minutes: one reading serves everyone who lands in that time.
  const [table, arcade] = await Promise.all([publicPlans(300), arcadeNow()])
  const plans = await offeredPlans(table)
  const getPlan = (key: string, term: 'month' | 'year' = 'month') => {
    const account = `/account?get=${key}${term === 'year' ? '&term=year' : ''}&reason=pricing`
    return signedIn ? account : withSource(`/sign-up?next=${encodeURIComponent(account)}`, source)
  }
  return { signedIn, create, plans, table, getPlan, arcade, bedrock: bedrockLive() }
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

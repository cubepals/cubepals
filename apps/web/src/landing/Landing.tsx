// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What the landing page reads (who is signed in, where its buttons lead, the plans, Cubepals' own
 * servers as they are now), and the frame it is set in (the type, what reports the marks, the foot
 * of the page and the structured data). Not the page itself (`Page.tsx`), nor the title and
 * description (`metadata.ts`).
 */
import type { PublicPlan } from '@blockly/contracts'
import type { ReactNode } from 'react'
import { Presses } from '../app/(public)/presses'
import type { PublicStatus } from '../app/(public)/status'
import { bedrockLive } from '../lib/bedrock'
import { pricedPlans } from '../lib/plans'
import { currentSession } from '../lib/session'
import { canonicalOrigin } from '../lib/site'
import { sourceOf, withSource } from '../lib/source'
import { appSchema, JsonLd, siteSchema } from '../lib/structured-data'
import { apiUpstream, RENDER_READ_MS } from '../lib/upstream'
import { digits, display, pixel } from './fonts'
import { Footer } from './sections/Footer'
import './landing.css'

/** What the page is given. */
export interface Landed {
  signedIn: boolean
  /** Where "Create a server" leads. */
  create: string
  /** The plans as every part of the page states them: what a month of each charges now (`pricedPlans`). */
  plans: PublicPlan[]
  /** Where a paid plan's button leads, by plan key, for a month or a year. */
  getPlan: (key: string, term?: 'month' | 'year') => string
  /** Cubepals' own Arcade as anyone can see it, or null unless it is known to be awake or asleep. */
  arcade: PublicStatus | null
  /** Cubepals' own servers as anyone can see them, each known to be awake or asleep. */
  ours: PublicStatus[]
  /** Whether the pages say Bedrock friends can join (lib/bedrock.ts). */
  bedrock: boolean
}

/** Cubepals' own servers on the public status endpoint, the Arcade first. */
const OURS = ['arcade', 'duels'] as const

/**
 * A server's public status, read on the server the way Browse reads a server's (status.ts), and
 * kept half a minute: the browser asks for nothing, so a server that isn't public costs it no
 * failed request. Null when it can't be read or the server is neither awake nor asleep.
 */
async function statusNow(slug: string): Promise<PublicStatus | null> {
  try {
    const response = await fetch(`${apiUpstream()}/api/public/servers/${slug}`, {
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
  const [plans, statuses] = await Promise.all([pricedPlans(300), Promise.all(OURS.map(statusNow))])
  const ours = statuses.filter((status): status is PublicStatus => status !== null)
  const getPlan = (key: string, term: 'month' | 'year' = 'month') => {
    const account = `/account?get=${key}${term === 'year' ? '&term=year' : ''}&reason=pricing`
    return signedIn ? account : withSource(`/sign-up?next=${encodeURIComponent(account)}`, source)
  }
  return { signedIn, create, plans, getPlan, arcade: statuses[0] ?? null, ours, bedrock: bedrockLive() }
}

/** The frame the page is set in. */
export function Frame({ plans, children }: { plans: PublicPlan[]; children: ReactNode }) {
  return (
    <div className={`lp ${display.variable} ${pixel.variable} ${digits.variable}`} data-landing>
      <Presses />
      {children}
      <Footer />
      <JsonLd schema={siteSchema(canonicalOrigin())} />
      <JsonLd schema={appSchema(plans, canonicalOrigin())} />
    </div>
  )
}

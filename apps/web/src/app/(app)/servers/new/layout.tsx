import { headers } from 'next/headers'
import type { ReactNode } from 'react'
import { PlayerCountry } from './region'

/**
 * The create page, given the country its request came from, so a new server starts in the region
 * nearest the player (region.tsx). Vercel's edge says it in `x-vercel-ip-country`; the control
 * plane on Fly never sees it, since the page asks it nothing but what to offer. Anywhere else the
 * header is missing and the first region is the start, except locally, where DEV_COUNTRY plays the
 * edge so either start can be seen. A browser could send the header itself where no edge
 * overwrites it, and would only change its own starting region.
 */
export default async function NewServerLayout({ children }: { children: ReactNode }) {
  const country =
    (await headers()).get('x-vercel-ip-country') ??
    (process.env.NODE_ENV === 'development' ? process.env.DEV_COUNTRY : undefined) ??
    null
  return <PlayerCountry country={country}>{children}</PlayerCountry>
}

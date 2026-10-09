import type { Metadata } from 'next'
import { Chat } from '../landing/Chat'
import { Chunk } from '../landing/Chunk'
import { Cursor } from '../landing/Cursor'
import { Follow } from '../landing/Follow'
import {
  Asks,
  Asleep,
  Built,
  Copied,
  Daybreak,
  Decided,
  Fitted,
  Kept,
  Knock,
  Last,
  Leaves,
  Night,
  Sent,
  Wake,
} from '../landing/film/Film'
import { digits, display, pixel } from '../landing/fonts'
import { Gauge } from '../landing/Gauge'
import { Strata } from '../landing/kit'
import { Scroll } from '../landing/Scroll'
import { Address } from '../landing/sections/Address'
import { Backups } from '../landing/sections/Backups'
import { Fleet } from '../landing/sections/Fleet'
import { Footer } from '../landing/sections/Footer'
import { Ledger } from '../landing/sections/Ledger'
import { Machine } from '../landing/sections/Machine'
import { Overview, Worlds } from '../landing/sections/Overview'
import { Packs } from '../landing/sections/Packs'
import { Plans } from '../landing/sections/Plans'
import { Runtimes } from '../landing/sections/Runtimes'
import { Sleep } from '../landing/sections/Sleep'
import { Type } from '../landing/Type'
import { publicPlans } from '../lib/plans'
import { currentSession } from '../lib/session'
import { canonicalOrigin } from '../lib/site'
import { sourceOf, withSource } from '../lib/source'
import { appSchema, JsonLd, siteSchema } from '../lib/structured-data'
import '../landing/landing.css'

// "Minecraft" is what people search for and read first; it is never the first word of the name.
// One address for the page, however a link to it was tagged (`?utm_source=…`).
const TITLE = 'Cubepals · Minecraft server hosting for friends'
const DESCRIPTION =
  'A Minecraft server that starts when your friends join. Free to start, no card needed. For Minecraft: Java Edition.'
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: { siteName: 'Cubepals', type: 'website', title: TITLE, description: DESCRIPTION, url: '/' },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
}

/**
 * The landing page: a film the scroll plays, on one Minecraft chunk. One beat to a screen, the
 * picture the whole of it, one sentence each, and each beat's action played once as the page
 * comes to rest on it. Night; somebody types the address; under the grass the server wakes; day,
 * and the friends walk in; the two things it asks, and everything it didn't; everyone leaves and
 * it sleeps; then the dig, for the curious, through the rooms under the house; all the worlds;
 * what it costs; the button. What each beat claims is demonstrated one layer down, behind "How
 * it works". The design's rules are in landing/README.md.
 */

export default async function Landing({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const signedIn = (await currentSession()) !== null
  const source = sourceOf(await searchParams)
  const create = signedIn ? '/servers/new' : withSource('/sign-up', source)
  // Kept five minutes: one reading serves everyone who lands in that time.
  const plans = await publicPlans(300)
  const getPlan = (key: string) => {
    const account = `/account?get=${key}&reason=pricing`
    return signedIn ? account : withSource(`/sign-up?next=${encodeURIComponent(account)}`, source)
  }
  return (
    <div className={`bl ${display.variable} ${pixel.variable} ${digits.variable}`} data-landing data-film>
      <Scroll />
      <Type />
      <Cursor />
      <Chat />
      <Gauge />
      <Follow create={create} />
      <main>
        <div className="bl-dig">
          <div className="bl-spine">
            <Chunk />
          </div>
          <Night create={create} signedIn={signedIn} />
          <Knock />
          <Strata from="var(--night)" to="var(--stone)" />
          <Wake proof={<Address plans={plans} bare />} />
          <Strata from="var(--stone)" to="var(--night)" />
          <Daybreak />
          <Asks />
          <Strata from="var(--paper)" to="var(--stone)" />
          <Decided plans={plans} proof={<Ledger plans={plans} bare />} />
          <Strata from="var(--stone)" to="var(--night)" />
          <Leaves />
          <Strata from="var(--night)" to="var(--stone)" />
          <Asleep proof={<Sleep plans={plans} bare />} />
          <Strata from="var(--stone)" to="var(--paper)" />
          <Overview played>
            <a className="bl-btn" href="#price">
              Straight to what it costs
            </a>
          </Overview>
          <Strata from="var(--paper)" to="var(--stone)" />
          <Built proof={<Machine bare />} />
          <Fitted proof={<Packs plans={plans} bare />} />
          <Copied proof={<Backups plans={plans} bare />} />
          <Strata from="var(--stone)" to="var(--slate)" />
          <Sent proof={<Runtimes bare />} />
          <Kept proof={<Fleet bare />} />
          <Strata from="var(--slate)" to="var(--night)" drawn />
          <Worlds played />
          <Strata from="var(--night)" to="var(--paper)" drawn />
          <Plans plans={plans} create={create} getPlan={getPlan} />
          <Last create={create} />
        </div>
      </main>
      <Footer />
      <JsonLd schema={siteSchema(canonicalOrigin())} />
      <JsonLd schema={appSchema(plans, canonicalOrigin())} />
    </div>
  )
}

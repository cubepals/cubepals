// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The film, whole: the parts that follow the page (the scrolling, the type, the crosshair, the
 * chat, the gauge, the button that follows), and every beat in order, the dig among them. Only `/`
 * sets it (app/page.tsx), so the route a phone is sent (app/phone) never loads its code. Not the
 * foot of the page, which the phone's page shares (Landing.tsx).
 */
import { SiteHeader } from '../../app/(public)/header'
import { ctaMark } from '../../app/(public)/steps'
import { Chat } from '../Chat'
import { Chunk } from '../Chunk'
import { Cursor } from '../Cursor'
import { Gauge } from '../Gauge'
import { Strata } from '../kit'
import type { Landed } from '../Landing'
import { Scroll } from '../Scroll'
import { Overview, Worlds } from '../sections/Overview'
import { Plans } from '../sections/Plans'
import { Type } from '../Type'
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
} from './Film'
import {
  AddressProof,
  BackupsProof,
  FleetProof,
  LedgerProof,
  MachineProof,
  PacksProof,
  RuntimesProof,
  SleepProof,
  WarmProofs,
} from './proofs'

export function FilmPage({ create, signedIn, plans, getPlan, arcade, bedrock }: Landed) {
  return (
    <>
      <Scroll />
      <WarmProofs />
      <Type />
      <Cursor />
      <Chat />
      <Gauge />
      <SiteHeader signedIn={signedIn} create={create} marks="nav" over />
      <main>
        <div className="bl-dig">
          <div className="bl-spine">
            <Chunk />
            {/* The hero as printed beforehand, until the canvas has its own lit print (landing.css). */}
            {/* biome-ignore lint/performance/noImgElement: a print one pixel a dot, scaled whole, never re-encoded. */}
            <img
              className="bl-first"
              src="/imagery/landing-hero.png"
              srcSet="/imagery/landing-hero.png 1x, /imagery/landing-hero-2x.png 2x"
              width={1440}
              height={900}
              alt=""
              fetchPriority="high"
              aria-hidden
            />
          </div>
          <Night create={create} plans={plans} arcade={arcade} bedrock={bedrock} />
          <Knock />
          <Strata from="var(--night)" to="var(--slate)" />
          <Wake proof={<AddressProof plans={plans} bare />} />
          <Strata from="var(--slate)" to="var(--night)" />
          <Daybreak />
          <Asks />
          <Strata from="var(--paper)" to="var(--slate)" />
          <Decided plans={plans} proof={<LedgerProof plans={plans} bare />} />
          <Strata from="var(--slate)" to="var(--night)" />
          <Leaves />
          <Strata from="var(--night)" to="var(--slate)" />
          <Asleep proof={<SleepProof plans={plans} bare />} />
          <Strata from="var(--slate)" to="var(--paper)" />
          <Overview played>
            <a className="bl-btn" href="#price" {...ctaMark('to_price')}>
              Straight to what it costs
            </a>
          </Overview>
          <Strata from="var(--paper)" to="var(--slate)" />
          <Built proof={<MachineProof bare />} />
          <Fitted proof={<PacksProof plans={plans} bare />} />
          <Copied proof={<BackupsProof plans={plans} bare />} />
          <Strata from="var(--slate)" to="var(--bedrock)" />
          <Sent proof={<RuntimesProof bare />} />
          <Kept proof={<FleetProof bare />} />
          <Strata from="var(--bedrock)" to="var(--night)" drawn />
          <Worlds played />
          <Strata from="var(--night)" to="var(--paper)" drawn />
          <Plans plans={plans} create={create} getPlan={getPlan} />
          <Last create={create} plans={plans} />
        </div>
      </main>
    </>
  )
}

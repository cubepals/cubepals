// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The film, whole: the parts that follow the page (the scrolling, the type, the crosshair, the
 * chat, the gauge, the button that follows), and every beat in order, the dig among them. Only `/`
 * sets it (app/page.tsx), so the route a phone is sent (app/phone) never loads its code. Not the
 * foot of the page, which the phone's page shares (Landing.tsx).
 */
import { ctaMark } from '../../app/(public)/steps'
import { Chat } from '../Chat'
import { Chunk } from '../Chunk'
import { Cursor } from '../Cursor'
import { Follow } from '../Follow'
import { Gauge } from '../Gauge'
import { Strata } from '../kit'
import type { Landed } from '../Landing'
import { Scroll } from '../Scroll'
import { Address } from '../sections/Address'
import { Backups } from '../sections/Backups'
import { Fleet } from '../sections/Fleet'
import { Ledger } from '../sections/Ledger'
import { Machine } from '../sections/Machine'
import { Overview, Worlds } from '../sections/Overview'
import { Packs } from '../sections/Packs'
import { Plans } from '../sections/Plans'
import { Runtimes } from '../sections/Runtimes'
import { Sleep } from '../sections/Sleep'
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

export function FilmPage({ create, signedIn, plans, getPlan }: Landed) {
  return (
    <>
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
            <a className="bl-btn" href="#price" {...ctaMark('to_price')}>
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
    </>
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

import type { PublicPlan } from '@blockly/contracts'
import { Demo, Section } from '../kit'
import { LedgerDemo } from './LedgerDemo'
import styles from './ledger.module.css'

/**
 * The first thing under the grass, and the other half of the questions above it: everything a
 * Minecraft server needs settled that Blockly never asked about, written out for the server the
 * visitor just chose. The machine's voice starts here. There are no facts under this one: the
 * ledger is the facts.
 */
export function Ledger({ plans, bare }: { plans: PublicPlan[]; bare?: boolean }) {
  return (
    <Section
      bare={bare}
      name="What it didn’t ask"
      tone="stone"
      y={60}
      side="left"
      act="ledger"
      // In through the vault's open wall, nearly level, close on the server that stands in it.
      shot={{ x: 12.5, z: 4, az: 84, el: 11, span: 9.5, fov: 34, turn: 8 }}
      className={styles.ledger}
    >
      <h2 className="bl-h2">Everything it didn’t ask</h2>
      <p className="bl-lede">
        A Minecraft server needs all of this decided before anyone can join. Cubepals decides it from what you
        answered, and the parts you might care about can be changed later.
      </p>
      <Demo
        label="The ledger: every decision Cubepals makes for the server chosen above"
        note="Each value is the one Cubepals’ code sets as of October 2026, for a server called Sunset Valley until you name yours above. The address is an example. A square marks what the last choice changed. The machine under the house is a drawing of the idea, built from the game’s own blocks, and what the last choice changed is lit on it too."
      >
        <LedgerDemo plans={plans} />
      </Demo>
    </Section>
  )
}

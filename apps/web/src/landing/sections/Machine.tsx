// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The machine stratum: how two answers size a server's machine, what every start checks before
 * anyone is let in, and how a start that fails is read. The demonstration is MachineDemo; the facts
 * under it are the control plane's own constants, each cited beside its number.
 */
import type { ReactNode } from 'react'
import { Demo, Facts, Section } from '../kit'
import { MachineDemo } from './MachineDemo'
import styles from './machine.module.css'

/** The failures read out of a server's own output, tried in order. apps/control/src/minecraft/diagnosis.ts */
const SIGNATURES = 25
/** What Blockly can offer to do about one. diagnosis.ts */
const REMEDIES = 6
/** Seconds between status pings while a start is waited on. apps/control/src/app/operations/boot.ts */
const PING_EVERY_SECONDS = 2
/** The share of memory that becomes the Java heap, plain and with mods. apps/control/src/minecraft/runtime-spec.ts */
const HEAP_PERCENT = { plain: 75, modded: 65 }
/** From this size up, a gigabyte stays outside the heap. runtime-spec.ts */
const KEPT_OUTSIDE_FROM_GB = 3
/** How long a start is given to come up, and then to answer a ping. apps/control/src/main.node.ts */
const UP_WITHIN_SECONDS = 120
const READY_WITHIN_MINUTES = 10

/** A fact's second line: why it is so, in plain words. */
function Why({ children }: { children: ReactNode }) {
  return <span className={styles.why}>{children}</span>
}

export function Machine({ bare }: { bare?: boolean } = {}) {
  return (
    <Section bare={bare} tone="stone" room="machine" className={styles.machine}>
      <h2 className="bl-h2">A machine built for this world</h2>
      <p className="bl-lede">
        What you play and who’s playing decide its memory, its Java and its flags. When a start fails,
        Cubepals reads the crash and says what happened in a sentence.
      </p>

      <Demo
        label="One server start, told twice: what its owner reads, and what the machine is doing"
        note="Sped up, and nothing is really started. The modpack is an example; the log lines are ones Cubepals’ own tests read. Modpacks, bigger groups and a bigger size come with Plus."
      >
        <MachineDemo />
      </Demo>

      <Facts
        items={[
          {
            name: 'Crashes it can read',
            value: (
              <>
                {SIGNATURES} signatures, {REMEDIES} remedies
                {/* diagnosis.ts */}
                <Why>
                  Tried in order, and the first match wins. Out of memory comes first, because its stack trace
                  looks like a dozen other failures.
                </Why>
              </>
            ),
          },
          {
            name: 'Ready when it answers',
            value: (
              <>
                Server List Ping, every {PING_EVERY_SECONDS} s
                {/* apps/control/src/infra/mc-protocol/slp.ts */}
                <Why>
                  Minecraft’s own status question. An answer that names no version doesn’t count: something
                  answered before the game was up.
                </Why>
              </>
            ),
          },
          {
            name: 'Java heap',
            value: (
              <>
                {HEAP_PERCENT.plain}% of memory, {HEAP_PERCENT.modded}% with mods
                {/* runtime-spec.ts */}
                <Why>
                  From {KEPT_OUTSIDE_FROM_GB} GB up, at least a gigabyte stays outside it, for Java itself and
                  the system.
                </Why>
              </>
            ),
          },
          {
            name: 'A start is given',
            value: (
              <>
                {UP_WITHIN_SECONDS} s to come up, {READY_WITHIN_MINUTES} min to answer
                {/* boot.ts */}
                <Why>Making a new world can take minutes.</Why>
              </>
            ),
          },
        ]}
      />
    </Section>
  )
}

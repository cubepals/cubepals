// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The runtimes stratum, the first of the dark ground: one port between Blockly and whatever runs a
 * server, and the policy that decides which runtime a new server goes to. The port and three
 * adapters are built (apps/control/src/app/ports/runtime.ts). Running several runtimes at once,
 * the placement rules and the recorded decisions have not run in production yet, so the section
 * says "Being built". Every fact below is cited to the file it comes from. No provider is named: the page says what each runtime is.
 */
import type { ReactNode } from 'react'
import { Demo, Facts, Section } from '../kit'
import { RuntimesDemo } from './RuntimesDemo'
import styles from './runtimes.module.css'

/** A fact's second line: why it is so, in plain words. */
function Why({ children }: { children: ReactNode }) {
  return <span className={styles.why}>{children}</span>
}

export function Runtimes({ bare }: { bare?: boolean } = {}) {
  return (
    <Section bare={bare} tone="slate" room="runtimes" className={styles.runtimes}>
      <h2 className="bl-h2">It doesn’t matter whose machine it is</h2>
      <p className={styles.built}>
        <span className="bl-tag">Being built</span>
      </p>
      {/* The port: ensureProvisioned, start, stop, snapshot (apps/control/src/app/ports/runtime.ts). */}
      <p className={`bl-lede ${styles.words}`}>
        Everything above talks to one small interface: make a server, start it, stop it, copy its disk. Behind
        it can be a cloud that bills by the second or a machine rented by the month, and a rule decides where
        each new server goes and writes down why.
      </p>

      <Demo
        label="The rule ladder: a new server drops through the placement rules, and the decision is recorded"
        note="A simulation of the placement policy, slowed down to read. Production runs servers on one cloud, with no rules, so nothing like this has happened there yet. The rules, the servers and their ids are examples, and the two clouds go by cloud-a and cloud-b in place of their names. Every verdict is the code’s own sentence, and each bucket is the number the code gives that rule and that server. Here only the default can be full; in the policy, any runtime can."
      >
        <RuntimesDemo />
      </Demo>

      <Facts
        items={[
          {
            name: 'Which rule places a server',
            said: true,
            value: (
              <>
                the first that matches
                {/* apps/control/src/app/runtimes/persistence.ts, placement.ts; docs/runtimes.md */}
                <Why>
                  Rules are read in the order they were made. One for the default runtime, made first, keeps
                  its owners off a canary.
                </Why>
              </>
            ),
          },
          {
            name: 'Where the decision is kept',
            value: (
              <>
                runtime_decisions
                {/* packages/db/src/schema.ts; apps/control/src/app/runtimes/service.ts */}
                <Why>
                  Written in the same transaction that makes the server: the runtime, the rule, the reason,
                  who decided, and every runtime considered with why it was or wasn’t chosen.
                </Why>
              </>
            ),
          },
          {
            name: 'How a server changes runtime',
            value: (
              <>
                bun scripts/runtimes.ts move &lt;server&gt; --to &lt;runtime&gt;
                {/* docs/runtimes.md; apps/control/src/app/operations/handlers.ts */}
                <Why>
                  Only when an operator asks, never because a rule changed. A running server stops, a copy of
                  its world goes to the archive store, the other runtime restores from it and starts it: one
                  restart for players.
                </Why>
              </>
            ),
          },
          {
            name: 'When a runtime has no room',
            value: (
              <>
                no_room
                {/* placement.ts; docs/runtimes.md; apps/control/src/app/operations/handlers.ts */}
                <Why>
                  It is passed over for the next rule, then the default, and a full default overflows to the
                  first other runtime with room. If the room goes before a server’s first start, it starts on
                  the default instead, once, recorded as fell_back.
                </Why>
              </>
            ),
          },
        ]}
      />
    </Section>
  )
}

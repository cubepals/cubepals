/**
 * The fleet stratum: Blockly's own machines, run without a cluster. Each machine runs blocklyd; one
 * Postgres ledger says where every world is placed; a sleeping world holds only its disk, and its
 * memory is claimed in the ledger when it wakes. The demonstration is FleetDemo.
 *
 * None of it has run in production yet, so the section says "Being built". Every fact below is
 * cited to the file it comes from. What the page must not say: memory is overcommitted for the
 * worlds placed on a machine, never for the ones running; there is no automatic failover; a lost
 * machine loses what was played since the last uploaded backup; and containers share their
 * machine's kernel.
 */
import type { ReactNode } from 'react'
import { Demo, Facts, Section } from '../kit'
import { FleetDemo } from './FleetDemo'
import styles from './fleet.module.css'

/** A fact's second line: why it is so, in plain words. */
function Why({ children }: { children: ReactNode }) {
  return <span className={styles.why}>{children}</span>
}

export function Fleet({ bare }: { bare?: boolean } = {}) {
  return (
    <Section bare={bare} tone="slate" room="fleet" className={styles.fleet}>
      <h2 className="bl-h2">No cluster, on purpose</h2>
      <p className={styles.built}>
        <span className="bl-tag">Being built</span>
      </p>
      {/* docs/fleet.md; apps/control/src/infra/fleet/placement.ts */}
      <p className={`bl-lede ${styles.words}`}>
        Each of Cubepals’ own machines runs blocklyd, a small daemon written in Rust, and one ledger says
        where every world lives. A sleeping world holds only its disk and claims its memory when it wakes.
      </p>

      <Demo
        label="Asleep is disk, awake is memory: two machines, the worlds placed on them, the ledger that claims memory when one wakes, and a cable to cut"
        note="A simulation of the fleet’s code, tested on one machine and never run in production. The machines and their worlds are examples, with cores, disk and ports to spare, so only memory ever runs out here. Each step is slowed down to read, and the silence is sped up: a block on the cable is a heartbeat, 5 seconds after the last. If a machine is truly lost, whatever was played since a world’s last uploaded backup is lost with it."
      >
        <FleetDemo />
      </Demo>

      <Facts
        items={[
          {
            name: 'What blocklyd is',
            value: (
              <>
                blocklyd-x86_64-linux-musl, 8.3 MB
                {/* cubepals/blocklyd README.md; docs/fleet-operations.md; docs/fleet.md */}
                <Why>
                  Built as one static binary. It runs each world in a locked-down container, which shares the
                  machine’s kernel, and it never chooses where anything runs.
                </Why>
              </>
            ),
          },
          {
            name: 'The heartbeat',
            value: (
              <>
                FLEET_HEARTBEAT_SECONDS=5
                {/* apps/control/src/config/load.ts; cubepals/blocklyd docs/protocol.md; docs/fleet.md */}
                <Why>
                  Each one carries every copy the machine holds, so a machine that was cut off is back in step
                  on its first beat. Machines never talk to each other.
                </Why>
              </>
            ),
          },
          {
            name: 'How a machine joins',
            value: (
              <>
                POST /fleet/v1/enroll
                {/* cubepals/blocklyd docs/protocol.md; docs/fleet.md; apps/control/src/infra/fleet/registry.ts */}
                <Why>
                  With a token that works once, for one machine, for an hour unless set otherwise. The machine
                  makes its own key, and from then on both sides prove who they are on every call: TLS 1.3,
                  both ways.
                </Why>
              </>
            ),
          },
          {
            name: 'Who may declare a machine lost',
            value: (
              <>
                bun scripts/fleet.ts lost &lt;node&gt; --fenced-by "…" --reason "…"
                {/* docs/fleet.md; docs/fleet-operations.md; apps/control/src/infra/fleet/registry.ts */}
                <Why>
                  An operator, never a timer, and only by saying how the machine was stopped. Called wrong, it
                  would leave two copies of a world running.
                </Why>
              </>
            ),
          },
        ]}
      />
    </Section>
  )
}

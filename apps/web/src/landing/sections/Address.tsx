/**
 * The first stratum under the grass: the edge. Game servers have no public address; every player
 * arrives at one door, which reads the name they typed and sends them through, and answers for a
 * server that is asleep. The demonstration knocks on it by itself, and lets someone else knock.
 *
 * The heading says "while the server sleeps", not "always": a resting world has no route while it
 * is being woken or put away, and an unknown name is closed without an answer.
 */
import type { PublicPlan } from '@blockly/contracts'
import { Demo, Facts, Section } from '../kit'
import { AddressDemo } from './AddressDemo'
import styles from './address.module.css'

export function Address({ plans = [], bare }: { plans?: PublicPlan[]; bare?: boolean }) {
  // The example server is the hero's, on the free plan; without the plans its row shows no limit.
  const free = plans.find((plan) => plan.monthlyPriceCents === 0)

  return (
    <Section bare={bare} tone="stone" room="edge" className={styles.address}>
      <h2 className="bl-h2">One address that answers while the server sleeps</h2>
      <p className="bl-lede">
        Every player arrives at one door, the edge, which reads the name they typed and sends them through. A
        join is what wakes a sleeping server.
      </p>

      <Demo
        label="A server list row for an example address, the wire a refresh or a join travels to whichever end answers, and the handshake the edge reads"
        note={
          <>
            Sped up, with an example address. It shows a server that is up within the hold. On the staging
            machines in September 2026 a wake took longer than <span className="bl-mono">25 s</span>, so the
            first join was dropped with no message and the player had to join again.
          </>
        }
      >
        <AddressDemo maxPlayers={free?.maxPlayers ?? null} />
      </Demo>

      <Facts
        items={[
          // ROUTES_POLL_MS, default 1000. apps/edge/agent.ts
          { name: 'The edge re-reads its routes', value: 'every 1000 ms' },
          // wakeWaitMs 25_000. apps/control/src/main.node.ts
          { name: 'A join is held for a wake', value: 'up to 25 s' },
          // A ping is answered by the edge's notice and never reported as a session.
          // apps/edge/agent.ts, apps/edge/notice.ts
          { name: 'A list refresh wakes a server, or keeps one awake', value: 'never', said: true },
          // One shared edge address routes every server by name. docs/architecture.md
          { name: 'Public addresses on a game server', value: 'none', said: true },
        ]}
      />
    </Section>
  )
}

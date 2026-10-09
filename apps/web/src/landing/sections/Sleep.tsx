/**
 * The sleep stratum: a server is awake only around the people on it, and that is what a player's
 * hours are counted by. The demonstration is
 * SleepDemo: a week the viewer fills in, against the same week on a server that never sleeps, and
 * then what is kept for a world nobody plays at all. Left alone, it plays both by itself.
 *
 * The words say "while someone is on it, and for some minutes after", never "only while you play":
 * the minutes before a sleep count too.
 *
 * The demonstration plays a wake as one join that gets in. On real machines it wasn't: the wake
 * took longer than the edge holds a join (wakeWaitMs, apps/control/src/main.node.ts), and that
 * join was dropped. The note under the demonstration says so.
 */
import type { PublicPlan } from '@blockly/contracts'
import type { ReactNode } from 'react'
import { Demo, Facts, Section } from '../kit'
import { SleepDemo } from './SleepDemo'
import styles from './sleep.module.css'

/**
 * Minutes a player may stand still before Minecraft kicks them, on every plan: the plan table's
 * `playerIdleKickMinutes`, which the public plans don't carry.
 * apps/control/src/domain/account/entitlements.ts
 */
const AFK_KICK_MINUTES = 15

/** A fact's second line: why it is so, in plain words. */
function Why({ children }: { children: ReactNode }) {
  return <span className={styles.why}>{children}</span>
}

export function Sleep({ plans, bare }: { plans: PublicPlan[]; bare?: boolean }) {
  const free = plans.find((plan) => plan.monthlyPriceCents === 0)
  const paid = plans.find((plan) => plan.monthlyPriceCents > 0)
  const minutes = free?.sleepsAfterMinutes ?? null
  // The paid plan's own number, where it differs: the way the pricing page says it.
  const onPaid =
    paid && paid.sleepsAfterMinutes !== null && paid.sleepsAfterMinutes !== minutes
      ? ` (${paid.sleepsAfterMinutes} on ${paid.name})`
      : ''

  return (
    <Section bare={bare} tone="stone" room="sleep" className={styles.sleep}>
      <h2 className="bl-h2">Asleep is its normal state</h2>
      <p className="bl-lede">
        A server runs while someone is on it, and for{' '}
        {minutes === null ? 'a few minutes' : `${minutes} minutes${onPaid}`} after the last player leaves.
        Then it saves the world and stops, and the hours stop counting with it.
      </p>

      <Demo
        label="A week of evenings to fill with play, what that week keeps a server awake for beside a server that never sleeps, and then the days nobody plays: a machine, a disk and a stored copy, and a join on any day"
        note="An example week, with a month taken as a twelfth of a year. The days, the rest and the wake are sped up, and nothing is really started. It shows a join that gets in as the server comes up; on the staging machines in September 2026 a wake outlasted the join that asked for it, so that join was dropped with no message and the friend joined again."
      >
        <SleepDemo plans={plans} />
      </Demo>

      <Facts
        items={[
          {
            name: 'Who is on',
            value: (
              <>
                {/* LIST_UUIDS, apps/control/src/minecraft/console.ts; presence-sync runs on
                    '* * * * *', apps/control/src/infra/pg/jobs.ts */}
                list uuids, every minute
                {/* apps/control/src/app/servers/usage.ts */}
                <Why>
                  Asked of the server’s own console. Its answer replaces whatever a connection claimed on the
                  way in.
                </Why>
              </>
            ),
          },
          {
            name: 'A player standing still',
            value: (
              <>
                {/* PLAYER_IDLE_TIMEOUT, apps/control/src/minecraft/runtime-spec.ts */}
                kicked after {AFK_KICK_MINUTES} min
                {/* mayChooseAfkKick, entitlements.ts */}
                <Why>
                  So one idle player doesn’t keep it awake and spend the hours.
                  {paid ? ` On ${paid.name} the owner can change that.` : ''}
                </Why>
              </>
            ),
          },
          {
            name: 'Before it stops',
            value: (
              <>
                {/* SAVE_ALL_FLUSH, console.ts; sent by every stop,
                    apps/control/src/app/operations/handlers.ts */}
                save-all flush
                <Why>
                  After reading back any change made in the game to who can join. Only then is the machine
                  stopped.
                </Why>
              </>
            ),
          },
          {
            name: 'A join nobody completes',
            value: (
              <>
                {/* IdleDecision, apps/control/src/app/operations/schedules.ts */}
                nobody_joined
                <Why>
                  A connection can wake a server. If no player follows it in, it is put back to sleep without
                  waiting out the plan’s minutes.
                </Why>
              </>
            ),
          },
        ]}
      />
    </Section>
  )
}

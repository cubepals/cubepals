// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The game's own watchdogs, off on every server. Each kills a server whose tick has run past a
 * limit, measured on the monotonic clock, which a freeze doesn't stop: a server frozen asleep on a
 * node for longer than the limit took its first tick after the thaw for one that long, and shut
 * itself down (26.3 frozen 75 s: "A single server tick took 74.98 seconds"). Fly's suspend stops
 * the guest's clock as well, so there it changes nothing.
 *
 * - `MAX_TICK_TIME=-1` is Minecraft's `max-tick-time`: at -1 its watchdog thread never starts.
 *   The image writes it to `server.properties` with the other settings it owns.
 * - On Paper, `-Ddisable.watchdog=true` (Paper's `WatchdogThread.DISABLE_WATCHDOG`) keeps its own
 *   watchdog from acting on a long tick while the server runs; it still acts on a server that
 *   hangs as it stops. `settings.timeout-time` in `spigot.yml` can't do it: Paper reads 0 or less
 *   there as 300 s, and the file is the owner's.
 *
 * A server that really hangs is no longer killed by the game: the control plane restarts one that
 * runs and has answered nothing for minutes (`app/operations/schedules/silent.ts`). Not for how
 * much memory a server has, or its JVM's flags (`runtime-spec.ts`).
 */

/** Minecraft's `max-tick-time` that never starts its watchdog. */
const NO_TICK_LIMIT = '-1'

/** The Java property that turns Paper's watchdog off (Paper's `WatchdogThread`). */
const PAPER_NO_WATCHDOG = 'disable.watchdog=true'

/**
 * Both watchdogs off: `MAX_TICK_TIME` always, and on Paper the property added to those the
 * server already passes to Java (`JVM_DD_OPTS`, space-separated `name=value`, a pack's own).
 */
export function watchdogEnv(paper: boolean, properties: string | undefined): Record<string, string> {
  if (!paper) return { MAX_TICK_TIME: NO_TICK_LIMIT }
  return {
    MAX_TICK_TIME: NO_TICK_LIMIT,
    JVM_DD_OPTS: [properties, PAPER_NO_WATCHDOG]
      .filter((part) => part !== undefined && part !== '')
      .join(' '),
  }
}

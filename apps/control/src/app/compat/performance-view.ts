// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The performance mods Cubepals adds to a Fabric server (`performance.ts`) as its settings page
 * shows them: whether its next start has them, who turned them off, and which ones, by name. Read
 * for the server's view (`servers/queries.ts`). It says what a start places, not what a running
 * server last started with: the switch applies at the next start, and the page says so.
 *
 * Changing the switch is `performance-switch.ts`'s.
 */
import type { PerformanceModsView } from '@blockly/contracts'
import type { Queryable } from '@blockly/db'
import { PERFORMANCE, PERFORMANCE_NAMES, runsPlugin } from '../../minecraft/mods.ts'
import { performanceIfOn, performanceOff, takesPerformance } from './performance.ts'

/** What the view reads of a revision: what `performanceIfOn` does. */
type Shown = Parameters<typeof performanceIfOn>[1]

/**
 * The performance mods as the server's settings page shows them; null on a server they are not
 * for. On, `mods` names the ones its next start places; off, the ones it would place if they were
 * turned on, so the page can say what the switch brings back. `runs` names those and the ones its
 * owner runs as their own mod, in Cubepals' order: the page names a server's performance mods the
 * same way whoever's copy each is, and only a server with none of either has none to name.
 */
export async function performanceModsView(
  q: Queryable,
  serverId: string,
  revision: Shown,
): Promise<PerformanceModsView | null> {
  if (!takesPerformance(revision)) return null
  const turnedOff = await performanceOff(q, serverId)
  const placed = await performanceIfOn(q, revision)
  const runs = PERFORMANCE.flatMap((id) =>
    runsPlugin(revision.mods, id)
      ? [PERFORMANCE_NAMES[id] ?? id]
      : placed.filter((mod) => runsPlugin([mod], id)).map((mod) => mod.name),
  )
  return { on: turnedOff === null, turnedOff, mods: placed.map((mod) => mod.name), runs }
}

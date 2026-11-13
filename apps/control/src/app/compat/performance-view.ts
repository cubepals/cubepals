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
import { type Queryable, schema } from '@blockly/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { PERFORMANCE, runsPlugin } from '../../minecraft/mods.ts'
import { performanceFor, performanceOff, takesPerformance } from './performance.ts'

const { compatPlugins } = schema

/** What the view reads of a revision: what `performanceFor` does. */
type Shown = Parameters<typeof performanceFor>[2]

/**
 * The performance mods as the server's settings page shows them; null on a server they are not
 * for. On, `mods` names the ones its next start places; off, the ones it would place if they were
 * turned on, so the page can say what the switch brings back.
 */
export async function performanceModsView(
  q: Queryable,
  serverId: string,
  revision: Shown,
): Promise<PerformanceModsView | null> {
  if (!takesPerformance(revision)) return null
  const turnedOff = await performanceOff(q, serverId)
  const mods =
    turnedOff === null
      ? (await performanceFor(q, serverId, revision)).map((mod) => mod.name)
      : await namesIfOn(q, revision)
  return { on: turnedOff === null, turnedOff, mods }
}

/**
 * The names of the ones a start would place were they on: those pinned for the release, but any the
 * owner runs already, in `PERFORMANCE`'s order, as `performanceFor` places them.
 */
async function namesIfOn(q: Queryable, revision: Pick<Shown, 'gameVersion' | 'mods'>): Promise<string[]> {
  const wanted = PERFORMANCE.filter((id) => !runsPlugin(revision.mods, id))
  if (wanted.length === 0) return []
  const rows = await q
    .select({ projectId: compatPlugins.projectId, pinned: compatPlugins.pinned })
    .from(compatPlugins)
    .where(and(eq(compatPlugins.gameVersion, revision.gameVersion), inArray(compatPlugins.projectId, wanted)))
  return wanted.flatMap((id) =>
    rows.filter((row) => row.projectId === id).map((row) => (row.pinned as PinnedMod).name),
  )
}

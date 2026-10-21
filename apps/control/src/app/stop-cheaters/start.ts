// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a start places for Stop cheaters (`servers/specs.ts`): where it is on and the server can run
 * Grim, Grim's jar as pinned for its release (none where the owner runs their own), and the
 * punishments file: an official server's own where its files name one, else STOP_CHEATERS', else
 * the public default. The file is written by the start's own step, never stored in a revision.
 * Nothing here restarts a server: like the Via plugins, it arrives at a start.
 */
import type { Queryable } from '@blockly/db'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { CarriedFile } from '../../domain/revision/carried.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { DEFAULT_PUNISHMENTS, PUNISHMENTS_FILE } from '../../minecraft/stop-cheaters.ts'
import { grimFor } from '../compat/service.ts'
import { tuning } from '../tuning.ts'
import { loadStopCheaters } from './persistence.ts'
import { effective } from './rule.ts'

export interface StopCheatersStart {
  /** What the start places; null where Stop cheaters doesn't run. */
  placed: { jar: PinnedMod | null; punishments: string; takeOver: boolean } | null
  /** The official files to place, without the punishments file where the step writes it instead. */
  officialFiles: readonly CarriedFile[]
}

export async function stopCheatersAtStart(
  q: Queryable,
  serverId: string,
  revision: ServerRevision,
  officialFiles: readonly CarriedFile[],
): Promise<StopCheatersStart> {
  const row = await loadStopCheaters(q, serverId)
  if (!effective(row).on) return { placed: null, officialFiles }
  const grim = await grimFor(q, revision)
  if (grim.kind !== 'placed') return { placed: null, officialFiles }
  const own = officialFiles.find((file) => file.path === PUNISHMENTS_FILE)
  return {
    placed: {
      jar: grim.jar,
      punishments: own?.content ?? tuning().stopCheaters?.punishments ?? DEFAULT_PUNISHMENTS,
      takeOver: row.takeOver,
    },
    officialFiles: officialFiles.filter((file) => file.path !== PUNISHMENTS_FILE),
  }
}

/**
 * The punishments a start writes, given whether it places the join reporter, whose `cubepals-remove`
 * every removal goes through. Without it a file that removes would remove nobody, so the start writes
 * the public default instead, alerts and logs only, and an admin alert says why
 * (`stop_cheaters_no_reporter`).
 */
export function withRemovals(
  placed: StopCheatersStart['placed'],
  reporter: boolean,
): StopCheatersStart['placed'] {
  return placed === null || reporter ? placed : { ...placed, punishments: DEFAULT_PUNISHMENTS }
}

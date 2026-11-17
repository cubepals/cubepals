// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Offline world progression (`progression.ts`) as the server's settings page shows it: whether its
 * next start has it, who turned it off, and which of its parts are on. Read for the server's view (`servers/queries.ts`). It
 * says what a start places, not what a running server last started with: the switch applies at
 * the next start, and the page says so.
 *
 * Changing the switch is `switch.ts`'s.
 */
import type { ProgressionView } from '@blockly/contracts'
import type { Queryable } from '@blockly/db'
import { type Progressed, progressionKind, progressionOff, progressionParts } from './progression.ts'

/** Offline world progression as the server's settings page shows it; null on a server it isn't for. */
export async function progressionView(
  q: Queryable,
  serverId: string,
  revision: Progressed,
): Promise<ProgressionView | null> {
  if (progressionKind(revision) === null) return null
  const turnedOff = await progressionOff(q, serverId)
  return { on: turnedOff === null, turnedOff, parts: await progressionParts(q, serverId) }
}

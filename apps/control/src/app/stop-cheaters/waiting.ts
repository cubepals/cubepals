// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stop cheaters as its owner set it, against what the running server's boot placed: the change a
 * restart would bring, if any. The switch (`service.ts`) restarts for it, or leaves it waiting for
 * everyone to leave; drift (`operations/schedules/drift.ts`) brings the owner's own once nobody is
 * on (`ownersStopCheatersWaiting`); and the server's page shows it as waiting (`servers/waiting.ts`).
 * Not for what a start places, which is `start.ts`'s.
 */
import type { AppliedConfigJson, Queryable } from '@blockly/db'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { GRIM_FIELDS, grimFor } from '../compat/service.ts'
import { loadRevisionFields } from '../servers/revision-reads.ts'
import { loadStopCheaters } from './persistence.ts'
import { effective } from './rule.ts'

/**
 * What a restart would change about Stop cheaters on a running server: turn it `on` or `off`, or
 * put Cubepals' settings in place of the owner's own (`ours`). Null where it would change nothing,
 * and where the server isn't running. A boot from before boots said what they placed is read by the
 * mark its access sync left (`recordStartMark`), which it has had since it booted.
 */
export async function stopCheatersWaiting(
  q: Queryable,
  server: Pick<MinecraftServer, 'id' | 'desiredRevisionId' | 'lifecycle'>,
  applied: AppliedConfigJson | null,
): Promise<'on' | 'off' | 'ours' | null> {
  if (server.lifecycle.status !== 'running' || applied === null) return null
  const placed = applied.placedStopCheaters ?? applied.stopCheaters !== undefined
  const row = await loadStopCheaters(q, server.id)
  const grim = await grimFor(q, await loadRevisionFields(q, server.desiredRevisionId, GRIM_FIELDS))
  const wanted = effective(row).on && grim.kind === 'placed'
  if (wanted !== placed) return wanted ? 'on' : 'off'
  return wanted && row.takeOver ? 'ours' : null
}

/**
 * What `stopCheatersWaiting` finds where the owner's own switch asks for it: their `on` or `off`,
 * or their ask for Cubepals' settings. What Cubepals turned on itself, by publishing, the official
 * flag or a template, arrives at the next start, as `service.ts` keeps automatic changes.
 */
export async function ownersStopCheatersWaiting(
  q: Queryable,
  server: Pick<MinecraftServer, 'id' | 'desiredRevisionId' | 'lifecycle'>,
  applied: AppliedConfigJson | null,
): Promise<'on' | 'off' | 'ours' | null> {
  const waiting = await stopCheatersWaiting(q, server, applied)
  if (waiting === null || waiting === 'ours') return waiting
  const row = await loadStopCheaters(q, server.id)
  return row.setting === waiting && row.reason === null ? waiting : null
}

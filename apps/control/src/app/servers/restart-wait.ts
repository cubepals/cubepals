// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether an owner's change restarts a running server now or waits for its players to leave: what
 * the services that make changes ask (`revisions/service.ts`, `stop-cheaters/service.ts`). What
 * waits, and the owner's ways out of it, are `waiting.ts`'s.
 */
import type { RestartWhen } from '@blockly/contracts'
import { type AppliedConfigJson, type Queryable, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type ChangeFacts, describeChanges, type ServerSettings } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { settingTakes } from '../../minecraft/settings.ts'
import { presenceFor } from './usage.ts'

/**
 * Whether a change that restarts a running server waits instead: the owner chose to wait for
 * everyone to leave, and someone is on it. With nobody on, or a server not running, nothing waits.
 */
export async function waitsForPlayers(
  q: Queryable,
  server: Pick<MinecraftServer, 'id' | 'lifecycle'>,
  when: RestartWhen,
): Promise<boolean> {
  if (when !== 'empty' || server.lifecycle.status !== 'running') return false
  return ((await presenceFor(q, [server.id])).get(server.id)?.length ?? 0) > 0
}

/**
 * Whether running `to` where `from` runs restarts the server: anything but settings the game
 * takes as people play (`settingTakes`), which a running server takes by command.
 */
export function restartsFor(from: ChangeFacts, to: ChangeFacts): boolean {
  return describeChanges(from, to).some(
    (change) =>
      (settingTakes(change.field as keyof ServerSettings, to.gameVersion) ?? 'restart') === 'restart',
  )
}

/** What a server's last boot applied, whichever provider runs it; null where nothing booted. */
export async function loadApplied(q: Queryable, serverId: string): Promise<AppliedConfigJson | null> {
  const [runtime] = await q
    .select({ applied: schema.serverRuntimes.applied })
    .from(schema.serverRuntimes)
    .where(eq(schema.serverRuntimes.serverId, serverId))
  return runtime?.applied ?? null
}

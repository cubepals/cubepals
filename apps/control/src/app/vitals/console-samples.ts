// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the servers the reporter plugin doesn't run on tick, read once a minute over their own
 * console with `tick query` (`operations/schedules/presence.ts`, in the pass that reads who is on):
 * vanilla, Fabric, Forge, NeoForge, modpacks, and Paper where `JOIN_REPORTER` leaves the plugin off.
 * Kept beside the plugin's samples, as `source` `console`, with what only the plugin sees left null.
 *
 * Not for reading a server's console; the pass does that. Not for the plugin's own samples
 * (`service.ts`).
 */
import { MINUTE_MS } from '@blockly/contracts/durations'
import { type Db, schema } from '@blockly/db'
import { and, eq, gte, inArray } from 'drizzle-orm'
import type { TickReading } from '../../minecraft/console.ts'
import { serverTicked } from '../platform/telemetry.ts'

/** A server whose plugin sampled it this recently is the plugin's; its console isn't read too. */
const REPORTER_FRESH_MS = 3 * MINUTE_MS

const v = schema.serverVitals

/** Of `serverIds`, the ones the reporter plugin sampled in the last few minutes. */
export async function reportingServers(
  db: Db,
  serverIds: readonly string[],
  now = new Date(),
): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set()
  const rows = await db
    .selectDistinct({ serverId: v.serverId })
    .from(v)
    .where(
      and(
        inArray(v.serverId, [...serverIds]),
        eq(v.source, 'reporter'),
        gte(v.at, new Date(now.getTime() - REPORTER_FRESH_MS)),
      ),
    )
  return new Set(rows.map((row) => row.serverId))
}

/**
 * Ticks a second as the server ran them: its target while it kept up, fewer when a tick took
 * longer than the target gives it.
 */
export function ticksPerSecond(reading: TickReading): number {
  if (reading.msptMean <= 0) return reading.targetTps
  return Math.min(reading.targetTps, 1000 / reading.msptMean)
}

/**
 * Keeps one console reading with the players `list` counted in the same pass; whether it was kept.
 * A frozen or sprinting server is an operator's doing, not how it plays, and isn't kept.
 */
export async function recordConsoleTick(
  db: Db,
  serverId: string,
  reading: TickReading,
  players: number,
  now = new Date(),
): Promise<boolean> {
  if (reading.state === 'frozen' || reading.state === 'sprinting') return false
  const kept = await db
    .insert(v)
    .values({
      serverId,
      at: now,
      source: 'console',
      tps: ticksPerSecond(reading),
      mspt: reading.msptMean,
      msptP95: reading.msptP95,
      msptMax: reading.msptP99,
      players,
    })
    .onConflictDoNothing()
    .returning({ mspt: v.mspt })
  for (const { mspt } of kept) serverTicked(mspt)
  return kept.length > 0
}

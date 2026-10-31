// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Db } from '@blockly/db'
import { schema } from '@blockly/db'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

/**
 * Makes a running server's run look as if it began `agoMs` ago: its open power interval, and when
 * it last became running, both. The idle decision reads the two together (`domain/server/idle.ts`),
 * so a test that moves only one fakes half a run.
 */
export async function backdateRun(db: Db, serverId: string, agoMs: number): Promise<Date> {
  const at = new Date(Date.now() - agoMs)
  await db
    .update(schema.powerIntervals)
    .set({ startedAt: at })
    .where(and(eq(schema.powerIntervals.serverId, serverId), isNull(schema.powerIntervals.stoppedAt)))
  await db
    .update(schema.minecraftServers)
    .set({ readyAt: at })
    .where(and(eq(schema.minecraftServers.id, serverId), isNotNull(schema.minecraftServers.readyAt)))
  return at
}

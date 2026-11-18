// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signals about what a server's machine went through where no player saw it, for the `signals` job
 * (`signals.ts`): its Java killed for want of memory (`out_of_memory`), at a stop, a boot or while it
 * ran, as `operations/out-of-memory.ts` keeps it; and a server booted in the background again and
 * again with nobody joining it (`background_boots`). Neither is a join's, and neither is one
 * operation going slowly (`operation-signals.ts`). The figures are the operators', in `SIGNALS`.
 */
import { DAY_MS, HOUR_MS } from '@blockly/contracts/durations'
import type { SignalsConfig } from '@blockly/contracts/join-records'
import { type Queryable, schema } from '@blockly/db'
import { and, count, eq, gt, like, notExists, sql } from 'drizzle-orm'
import { KILLED_WHILE_RUNNING, OUT_OF_MEMORY_MARK } from '../operations/out-of-memory.ts'
import { REFRESH_KEY } from '../servers/usage.ts'
import type { Raised } from './signal-kinds.ts'

const { serverOperations: operations, minecraftServers: servers, auditLog, joins } = schema

/** How far back kills are read: the job runs every minute, and keys keep each once. */
const READ_MS = HOUR_MS

const marked = (mark: string) => sql`${operations.steps} @> ${JSON.stringify([{ step: mark }])}::jsonb`

/** Each Java killed for want of memory lately: in a stop or boot, by its record, or while it ran. */
async function outOfMemory(q: Queryable, config: SignalsConfig, now: Date): Promise<Raised[]> {
  if (config.outOfMemory === undefined) return []
  const since = new Date(now.getTime() - READ_MS)
  const ops = await q
    .select({
      id: operations.id,
      serverId: operations.serverId,
      server: servers.name,
      kind: operations.kind,
      input: operations.input,
    })
    .from(operations)
    .innerJoin(servers, eq(servers.id, operations.serverId))
    .where(and(gt(operations.createdAt, new Date(now.getTime() - DAY_MS)), marked(OUT_OF_MEMORY_MARK)))
  const running = await q
    .select({ id: auditLog.id, serverId: auditLog.subjectId, server: servers.name, data: auditLog.data })
    .from(auditLog)
    .innerJoin(servers, sql`${servers.id}::text = ${auditLog.subjectId}`)
    .where(and(eq(auditLog.action, KILLED_WHILE_RUNNING), gt(auditLog.at, since)))
  return [
    ...ops.map((op) => ({
      kind: 'out_of_memory' as const,
      key: `out_of_memory:${op.id}`,
      serverId: op.serverId,
      joinId: null,
      at: now,
      detail: {
        server: op.server,
        during: op.kind === 'stop' ? 'stop' : 'boot',
        operation: op.id,
        operationKind: op.kind,
        reason: (op.input as { reason?: unknown } | null)?.reason ?? null,
      },
    })),
    ...running.map((row) => ({
      kind: 'out_of_memory' as const,
      key: `out_of_memory:${row.id}`,
      serverId: row.serverId,
      joinId: null,
      at: now,
      detail: { server: row.server, during: 'play', killedAt: row.data.killedAt ?? null },
    })),
  ]
}

/**
 * Servers booted in the background (a keep-ready refresh, a start after a startup recording) so
 * many times in the last day, with nobody joining them in it: background work that keeps coming
 * back for nothing, which nobody waits on and nothing else shows.
 */
async function backgroundBoots(q: Queryable, config: SignalsConfig, now: Date): Promise<Raised[]> {
  const limit = config.backgroundBoots?.perServerPerDay
  if (limit === undefined) return []
  const since = new Date(now.getTime() - DAY_MS)
  const joined = q
    .select({ one: sql`1` })
    .from(joins)
    .where(and(eq(joins.serverId, operations.serverId), eq(joins.kind, 'join'), gt(joins.connectedAt, since)))
  const rows = await q
    .select({ serverId: operations.serverId, server: servers.name, figure: count() })
    .from(operations)
    .innerJoin(servers, eq(servers.id, operations.serverId))
    .where(
      and(
        eq(operations.kind, 'start'),
        like(operations.idempotencyKey, `start:${REFRESH_KEY}%`),
        marked('booting'),
        gt(operations.createdAt, since),
        notExists(joined),
      ),
    )
    .groupBy(operations.serverId, servers.name)
  const day = now.toISOString().slice(0, 10)
  return rows
    .filter((row) => row.figure >= limit)
    .map((row) => ({
      kind: 'background_boots' as const,
      key: `background_boots:${row.serverId}:${day}`,
      serverId: row.serverId,
      joinId: null,
      at: now,
      detail: { server: row.server, figure: row.figure, limit },
    }))
}

/** Every signal about machines nobody saw at `now`, as the setting turns each kind on. */
export async function machineSignals(q: Queryable, config: SignalsConfig, now: Date): Promise<Raised[]> {
  return [...(await outOfMemory(q, config, now)), ...(await backgroundBoots(q, config, now))]
}

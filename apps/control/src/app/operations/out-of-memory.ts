// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's Java killed for want of memory, as its runtime says, kept where the `signals` job
 * reads it (`joins/machine-signals.ts`): on the record of the stop or boot it happened in
 * (`out_of_memory`), and in the audit log for one while it ran, which no operation holds: a crash,
 * or a failure the provider started the server again from without its ever looking stopped.
 *
 * A kill in a stop that was asked for is no crash, so nothing else keeps it: a Java killed as it
 * exits, after its world is saved, loses nobody anything and would otherwise go unseen however often
 * it happened. Not for deciding anything: what a crash does next is `schedules/reconcile.ts`'s.
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { type Queryable, schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import type { RuntimeHandle, RuntimeObservation } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import type { OperationContext } from './runner.ts'

/** The mark a stop or boot whose Java was killed for want of memory carries. */
export const OUT_OF_MEMORY_MARK = 'out_of_memory' satisfies Parameters<OperationContext['mark']>[0]

/** The audit log's action for a Java killed for want of memory while it ran. */
export const KILLED_WHILE_RUNNING = 'server.out_of_memory'

/**
 * How far a provider's clock may be from the control plane's: a kill this long before `since` is
 * still taken for one at or after it. A run's last exit before this one ended before it started.
 */
const CLOCKS_MS = 10 * SECOND_MS

/** Whether what the runtime says now is a kill for want of memory at `since` or after. */
const killedSince = (seen: RuntimeObservation, since: Date): boolean =>
  seen.killedForMemoryAt !== undefined && seen.killedForMemoryAt.getTime() >= since.getTime() - CLOCKS_MS

/**
 * Marks a stop or boot whose server's Java the runtime says was killed for want of memory since
 * `since`. A look that fails costs the operation nothing: it goes on as it would have.
 */
export async function markKilled(
  ctx: Pick<OperationContext, 'mark'>,
  runtime: Pick<Runtimes, 'observe'>,
  handle: RuntimeHandle,
  since: Date,
): Promise<void> {
  const seen = await runtime.observe(handle).catch(() => null)
  if (seen !== null && killedSince(seen, since)) await ctx.mark(OUT_OF_MEMORY_MARK)
}

/**
 * Keeps a Java killed for want of memory while it ran, as the crash it was: once a kill, by when the
 * runtime says it happened, however many passes see it.
 */
export async function keepKilledWhileRunning(q: Queryable, serverId: string, at: Date): Promise<void> {
  const killedAt = at.toISOString()
  const [kept] = await q
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, KILLED_WHILE_RUNNING),
        eq(schema.auditLog.subjectId, serverId),
        sql`${schema.auditLog.data} ->> 'killedAt' = ${killedAt}`,
      ),
    )
    .limit(1)
  if (kept !== undefined) return
  await q.insert(schema.auditLog).values({
    actor: 'system:reconcile',
    action: KILLED_WHILE_RUNNING,
    subjectType: 'server',
    subjectId: serverId,
    data: { killedAt },
  })
}

/**
 * Keeps a kill the provider started the server again from (`failedAt`), as its restart policy does
 * after a run fails: the server never looked stopped, so no crash was recorded. The kill must be
 * that failure: a machine booted after a stop killed for want of memory still shows that exit, which
 * was asked for and is no failure.
 */
export async function keepRestartedKill(
  q: Queryable,
  serverId: string,
  seen: RuntimeObservation,
): Promise<void> {
  const at = seen.killedForMemoryAt
  if (at === undefined || seen.failedAt?.getTime() !== at.getTime()) return
  await keepKilledWhileRunning(q, serverId, at)
}

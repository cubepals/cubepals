// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Queryable, schema, type Tx } from '@blockly/db'
import { and, desc, eq, gte, inArray, isNotNull, ne, notInArray, or, sql } from 'drizzle-orm'
import type { OperationKind } from '../../domain/server/lifecycle.ts'

const operations = schema.serverOperations

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface OperationRecord {
  id: string
  serverId: string
  kind: OperationKind
  status: OperationStatus
  input: Record<string, unknown>
  requestedBy: string
  idempotencyKey: string
  step: string | null
  /** What went wrong, in owners' words. */
  error: string | null
  /** What went wrong as it was said, for the platform's admins only. */
  detail: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}

type Row = typeof operations.$inferSelect

export const toRecord = (row: Row): OperationRecord => ({
  id: row.id,
  serverId: row.serverId,
  kind: row.kind,
  status: row.status,
  input: row.input,
  requestedBy: row.requestedBy,
  idempotencyKey: row.idempotencyKey,
  step: row.progress?.step ?? null,
  error: row.error,
  detail: row.detail,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  createdAt: row.createdAt,
})

export interface NewOperation {
  serverId: string
  kind: OperationKind
  input: Record<string, unknown>
  requestedBy: string
  idempotencyKey: string
}

/** Inserts the operation, or returns the one an earlier identical request already created. */
export async function insertOperation(
  tx: Tx,
  op: NewOperation,
): Promise<{ record: OperationRecord; created: boolean }> {
  // An access sync conflicts either with the one already queued or, asked for twice, with itself.
  // The queued one can start between the insert and the look: it may have read the entries
  // before this change, so the change gets a sync of its own, inserted again now that none waits.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await tx
      .insert(operations)
      .values({ id: crypto.randomUUID(), ...op })
      .onConflictDoNothing()
      .returning()
    if (row) return { record: toRecord(row), created: true }
    const [existing] = await tx
      .select()
      .from(operations)
      .where(
        op.kind === 'access_sync'
          ? and(
              eq(operations.serverId, op.serverId),
              eq(operations.kind, 'access_sync'),
              or(eq(operations.status, 'queued'), eq(operations.idempotencyKey, op.idempotencyKey)),
            )
          : and(eq(operations.serverId, op.serverId), eq(operations.idempotencyKey, op.idempotencyKey)),
      )
      .limit(1)
    if (existing) return { record: toRecord(existing), created: false }
  }
  throw new Error(`Operation ${op.kind} for ${op.serverId} conflicted but cannot be found`)
}

export async function loadOperation(q: Queryable, id: string): Promise<OperationRecord | null> {
  const [row] = await q.select().from(operations).where(eq(operations.id, id))
  return row ? toRecord(row) : null
}

const OPEN = ['queued', 'running'] as const

export async function markRunning(q: Queryable, id: string): Promise<void> {
  const at = new Date()
  await q
    .update(operations)
    .set({ status: 'running', startedAt: at, error: null, steps: withStep('attempt', at) })
    .where(and(eq(operations.id, id), inArray(operations.status, [...OPEN])))
}

export async function recordStep(q: Queryable, id: string, step: string): Promise<void> {
  const at = new Date()
  await q
    .update(operations)
    .set({ progress: { step, at: at.toISOString() }, steps: withStep(step, at) })
    .where(eq(operations.id, id))
}

/** A mark in `steps` (`OperationMark`): kept on the record, and not the operation's step. */
export async function recordMark(q: Queryable, id: string, mark: string): Promise<void> {
  await q
    .update(operations)
    .set({ steps: withStep(mark, new Date()) })
    .where(eq(operations.id, id))
}

/** `steps` with one more on the end (`OperationStepJson`), for where an operation's time went. */
const withStep = (step: string, at: Date) =>
  sql`coalesce(${operations.steps}, '[]'::jsonb) || ${JSON.stringify([{ step, at: at.toISOString() }])}::jsonb`

/** An attempt that failed and will be tried again: in owners' words, and in full for the platform. */
export async function recordAttemptError(
  q: Queryable,
  id: string,
  error: string,
  detail: string | null = null,
): Promise<void> {
  await q
    .update(operations)
    .set({ error: storable(error), detail: detail === null ? null : storable(detail) })
    .where(eq(operations.id, id))
}

/**
 * Text Postgres can keep: an error can quote raw bytes from a provider's stream, and a NUL in it
 * would make the failure itself impossible to record.
 */
const storable = (text: string) => text.replaceAll('\u0000', '')

/**
 * Records how an operation ended, once: the first outcome stands. An attempt that outlived its
 * deadline and returns after the operation was settled (retried, or discarded by an admin)
 * changes nothing. Says whether this call finished it.
 */
export async function finishOperation(
  q: Queryable,
  id: string,
  status: Exclude<OperationStatus, 'queued' | 'running'>,
  error: string | null = null,
  detail: string | null = null,
): Promise<boolean> {
  const finished = await q
    .update(operations)
    .set({
      status,
      error: error === null ? null : storable(error),
      detail: detail === null ? null : storable(detail),
      finishedAt: new Date(),
    })
    .where(and(eq(operations.id, id), inArray(operations.status, [...OPEN])))
    .returning({ id: operations.id })
  return finished.length > 0
}

/**
 * Work that doesn't change what the server is doing: it never locks the owner's pages, and the
 * server page doesn't show it as the server's progress.
 */
const BACKGROUND = ['access_sync', 'backup', 'archive', 'prune_worlds'] as const

/** The foreground operation people see on the server page. Background work is not shown. */
/** Whether a move of the server failed, or was refused, since `since`. */
/**
 * When the server's moves that ended last failed, one after another, newest first, up to `limit`:
 * none when the last one that ended didn't fail.
 */
export async function relocationFailures(q: Queryable, serverId: string, limit: number): Promise<Date[]> {
  const ended = await q
    .select({ status: operations.status, finishedAt: operations.finishedAt })
    .from(operations)
    .where(
      and(
        eq(operations.serverId, serverId),
        eq(operations.kind, 'relocate'),
        isNotNull(operations.finishedAt),
      ),
    )
    .orderBy(desc(operations.finishedAt))
    .limit(limit)
  const failed: Date[] = []
  for (const { status, finishedAt } of ended) {
    if (status !== 'failed' || finishedAt === null) break
    failed.push(finishedAt)
  }
  return failed
}

export async function activeOperation(q: Queryable, serverId: string): Promise<OperationRecord | null> {
  const [row] = await q
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.serverId, serverId),
        inArray(operations.status, ['queued', 'running']),
        notInArray(operations.kind, [...BACKGROUND]),
      ),
    )
    .orderBy(desc(operations.createdAt))
    .limit(1)
  return row ? toRecord(row) : null
}

/** Every operation under way, on any server: what a worker may have been running when it stopped. */
export async function runningOperationIds(q: Queryable): Promise<string[]> {
  const rows = await q.select({ id: operations.id }).from(operations).where(eq(operations.status, 'running'))
  return rows.map((row) => row.id)
}

/** The newest operation of one kind, finished or not, such as the last configuration change. */
export async function latestOfKind(
  q: Queryable,
  serverId: string,
  kind: OperationRecord['kind'],
): Promise<(OperationRecord & { finishedAt: Date | null }) | null> {
  const [row] = await q
    .select()
    .from(operations)
    .where(and(eq(operations.serverId, serverId), eq(operations.kind, kind)))
    .orderBy(desc(operations.createdAt))
    .limit(1)
  return row ? { ...toRecord(row), finishedAt: row.finishedAt } : null
}

/**
 * How a wake went: `resumed`, a server asleep with its memory kept coming back as it was, which its
 * steps say by `resuming` and no `booting` after it; or `booted`, every other, a provider that
 * dropped what it kept included. Wakes from before steps were kept booted.
 */
export type WakePath = 'resumed' | 'booted'

const resumedWake = sql<boolean>`coalesce(${operations.steps} @> '[{"step":"resuming"}]'::jsonb and not ${operations.steps} @> '[{"step":"booting"}]'::jsonb, false)`

/**
 * Whether the operation failed in waking its server rather than over what the server runs: it
 * gave up on a resume, or its server's host couldn't run it (`OperationMark`).
 */
export async function failedWaking(q: Queryable, operationId: string): Promise<boolean> {
  const marked = (mark: string) => sql`${operations.steps} @> ${JSON.stringify([{ step: mark }])}::jsonb`
  const [row] = await q
    .select({ id: operations.id })
    .from(operations)
    .where(and(eq(operations.id, operationId), or(marked('resume_hung'), marked('host_refused'))))
  return row !== undefined
}

/**
 * How many servers had a start since `since` carry `mark` (`OperationMark`), and the newest such
 * start: what the platform's alerts count. Servers, not starts, so one server's starts asked again
 * and again count once.
 */
export async function markedSince(
  q: Queryable,
  mark: string,
  since: Date,
): Promise<{ count: number; newest: { operationId: string; serverId: string } | null }> {
  const rows = await q
    .select({ id: operations.id, serverId: operations.serverId })
    .from(operations)
    .where(
      and(
        eq(operations.kind, 'start'),
        gte(operations.createdAt, since),
        sql`${operations.steps} @> ${JSON.stringify([{ step: mark }])}::jsonb`,
      ),
    )
    .orderBy(desc(operations.createdAt))
  const [first] = rows
  const servers = new Set(rows.map((row) => row.serverId)).size
  return { count: servers, newest: first ? { operationId: first.id, serverId: first.serverId } : null }
}

/**
 * How long the server's last wake by `path` took, from the press to running, in seconds: what its
 * next one that way is told to expect. Null before it ever woke that way.
 */
export async function lastWakeSeconds(
  q: Queryable,
  serverId: string,
  path: WakePath,
): Promise<number | null> {
  const [row] = await q
    .select({ createdAt: operations.createdAt, finishedAt: operations.finishedAt })
    .from(operations)
    .where(
      and(
        eq(operations.serverId, serverId),
        eq(operations.kind, 'start'),
        eq(operations.status, 'succeeded'),
        path === 'resumed' ? resumedWake : sql`not ${resumedWake}`,
      ),
    )
    .orderBy(desc(operations.createdAt))
    .limit(1)
  if (row?.finishedAt == null) return null
  return Math.round((row.finishedAt.getTime() - row.createdAt.getTime()) / 1000)
}

/** How a wake under way is going so far, by the steps it went through. */
export async function wakePathOf(q: Queryable, operationId: string): Promise<WakePath> {
  const [row] = await q
    .select({ resumed: resumedWake })
    .from(operations)
    .where(eq(operations.id, operationId))
  return row?.resumed === true ? 'resumed' : 'booted'
}

/** Work of these kinds waiting or under way on any of these servers, in one read. */
export async function openOfKinds(
  q: Queryable,
  serverIds: readonly string[],
  kinds: readonly OperationKind[],
): Promise<OperationRecord[]> {
  if (serverIds.length === 0) return []
  const rows = await q
    .select()
    .from(operations)
    .where(
      and(
        inArray(operations.serverId, [...serverIds]),
        inArray(operations.kind, [...kinds]),
        inArray(operations.status, ['queued', 'running']),
      ),
    )
  return rows.map(toRecord)
}

/**
 * The starts a wake that began at `since` asked for or found under way, newest first: those still
 * open, and those made since. A join's record names it, so its steps can be read beside the join.
 */
export async function wakeStarts(q: Queryable, serverId: string, since: Date): Promise<OperationRecord[]> {
  const rows = await q
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.serverId, serverId),
        inArray(operations.kind, ['start', 'unstore']),
        or(inArray(operations.status, ['queued', 'running']), gte(operations.createdAt, since)),
      ),
    )
    .orderBy(desc(operations.createdAt))
    .limit(1)
  return rows.map(toRecord)
}

/** Whether work of one kind is waiting or under way for a server, such as a backup being taken. */
export async function pendingOfKind(q: Queryable, serverId: string, kind: OperationKind): Promise<boolean> {
  const [row] = await q
    .select({ id: operations.id })
    .from(operations)
    .where(
      and(
        eq(operations.serverId, serverId),
        eq(operations.kind, kind),
        inArray(operations.status, ['queued', 'running']),
      ),
    )
    .limit(1)
  return row !== undefined
}

/** Whether anything but `exceptId` is waiting or under way for a server, background work included. */
export async function otherWork(q: Queryable, serverId: string, exceptId: string): Promise<boolean> {
  const [row] = await q
    .select({ id: operations.id })
    .from(operations)
    .where(
      and(
        eq(operations.serverId, serverId),
        inArray(operations.status, ['queued', 'running']),
        ne(operations.id, exceptId),
      ),
    )
    .limit(1)
  return row !== undefined
}

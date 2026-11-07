// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Each finished operation, kept once as `operation_finished` and sent to PostHog by the worker with
 * the funnel events (`record.ts`, `service.ts`): its kind, how it ended, how long it took from being
 * asked, whether a start resumed or booted, and the marks that say why (`other_spec`, `changed:*`,
 * `memory_lost`, `slept`, …). How wakes go is then a chart in PostHog, resume rate and wake time
 * by day, not a query. Never sent for a test account, as no event is.
 */
import { type Queryable, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { noteOnce } from './record.ts'

/** The event's name, which PostHog's charts of operations read. */
export const OPERATION_FINISHED = 'operation_finished'

const operations = schema.serverOperations

/** Steps every operation reports as it goes; what is left are the marks that say why. */
const PLAIN = new Set([
  'attempt',
  'allocating',
  'storage',
  'compute',
  'booting',
  'resuming',
  'starting',
  'loading_world',
  'verifying',
  'access',
])

/** How a start ended up, from its steps: `resumed`, `booted`, or empty for anything else. */
const wayOf = (steps: readonly string[]) =>
  steps.includes('resuming') && !steps.includes('booting')
    ? 'resumed'
    : steps.includes('booting')
      ? 'booted'
      : ''

/** Keeps the event for an operation that just finished, in the transaction that finished it. */
export async function operationFinished(
  q: Queryable,
  op: { id: string; kind: string; serverId: string; createdAt: Date },
  ownerId: string,
  status: 'succeeded' | 'cancelled' | 'failed',
  at = new Date(),
): Promise<void> {
  const [row] = await q.select({ steps: operations.steps }).from(operations).where(eq(operations.id, op.id))
  const steps = (row?.steps ?? []).map((entry) => entry.step)
  await noteOnce(q, {
    event: OPERATION_FINISHED,
    subject: op.id,
    userId: ownerId,
    at,
    properties: {
      kind: op.kind,
      status,
      seconds: Math.round((at.getTime() - op.createdAt.getTime()) / 1000),
      way: wayOf(steps),
      attempts: steps.filter((step) => step === 'attempt').length,
      marks: steps.filter((step) => !PLAIN.has(step)).join(','),
      server_id: op.serverId,
    },
  })
}

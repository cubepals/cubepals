// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signals read from how operations went (`operation-signals.ts`), and the email of the kinds the
 * setting asks for (`signal-mail.ts`), on a real database: a wake that booted with why, a slow
 * resume and a backup still running past its figure, an operation tried twice, each raised and
 * emailed once.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { SignalsConfig } from '@blockly/contracts/join-records'
import { schema } from '@blockly/db'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { Outbox } from '../../testing/outbox.ts'
import { installTuning, tuning } from '../tuning.ts'
import { tellSignals, type Written } from './signal-mail.ts'
import { raiseSignals } from './signals.ts'

let h: Harness
let serverId: string
const deployed = tuning()
const now = new Date()
const ago = (ms: number) => new Date(now.getTime() - ms)
const outbox = new Outbox()
const tell = (config: SignalsConfig, written: Written[]) =>
  tellSignals(
    { db: h.db, mailer: outbox, inbox: ['ops@example.test'], origin: 'http://localhost:3000' },
    config.notify,
    written,
  )
const operation = async (o: {
  kind: 'start' | 'backup' | 'stop'
  steps: string[]
  took: number
  running?: boolean
  error?: string
}) => {
  const id = randomUUID()
  const startedAt = ago(o.took + MINUTE_MS)
  await h.db.insert(schema.serverOperations).values({
    id,
    serverId,
    kind: o.kind,
    status: o.running ? 'running' : 'succeeded',
    requestedBy: 'system:wake',
    idempotencyKey: `${o.kind}:${id}`,
    steps: o.steps.map((step) => ({ step, at: startedAt.toISOString() })),
    error: o.error ?? null,
    createdAt: startedAt,
    startedAt,
    finishedAt: o.running ? null : new Date(startedAt.getTime() + o.took),
  })
  return id
}

describe.skipIf(!hasDatabase)('signals from operations', () => {
  beforeAll(async () => {
    h = await startHarness()
    serverId = (await h.create(await h.user(), { name: 'Operated' })).id
    await h.settled(serverId)
  }, 30_000)

  afterEach(async () => {
    installTuning(deployed)
    await h.db.delete(schema.signals)
    outbox.sent.length = 0
  })

  afterAll(async () => {
    await h?.close()
  })

  test('a wake that booted, a slow resume, a backup still running past its figure, a retry: each once', async () => {
    const booted = await operation({
      kind: 'start',
      steps: ['attempt', 'allocating', 'other_spec', 'changed:drift:image', 'booting', 'let_in'],
      took: 50 * SECOND_MS,
    })
    const slowResume = await operation({
      kind: 'start',
      steps: ['attempt', 'resuming'],
      took: 30 * SECOND_MS,
    })
    await operation({ kind: 'start', steps: ['attempt', 'resuming'], took: 3 * SECOND_MS })
    const longBackup = await operation({
      kind: 'backup',
      steps: ['attempt', 'saving'],
      took: 20 * MINUTE_MS,
      running: true,
    })
    const retried = await operation({
      kind: 'stop',
      steps: ['attempt', 'attempt'],
      took: 5 * SECOND_MS,
      error: 'Fly: 503',
    })
    installTuning({
      ...deployed,
      joins: {
        reporter: 'off',
        signals: {
          wakeBooted: {},
          slowOperation: { byKindS: { start: 90, backup: 600 }, resumeS: 15 },
          retriedOperation: {},
          notify: ['wake_booted', 'retried_operation'],
        },
      },
    })
    expect(await raiseSignals(h.db, now, tell)).toBe(4)
    const raised = await h.db.select().from(schema.signals)
    expect(raised.map((s) => s.key).sort()).toEqual(
      [
        `retried_operation:${retried}`,
        `slow_operation:${longBackup}`,
        `slow_operation:${slowResume}`,
        `wake_booted:${booted}`,
      ].sort(),
    )
    expect(raised.find((s) => s.kind === 'wake_booted')?.detail).toMatchObject({
      server: 'Operated',
      reasons: ['other_spec'],
      changed: ['drift:image'],
    })
    expect(raised.find((s) => s.key === `slow_operation:${longBackup}`)?.detail).toMatchObject({
      operationKind: 'backup',
      running: true,
      limit: 600,
    })

    // One email, of the kinds the setting asks for, saying why.
    expect(outbox.sent.map((m) => m.to)).toEqual(['ops@example.test'])
    const [email] = outbox.sent
    expect(email?.subject).toBe('Cubepals: 2 new signals')
    expect(email?.text).toContain('wake_booted on Operated: 50 s; because other_spec; changed drift:image')
    expect(email?.text).toContain('retried_operation on Operated: stop; 2 attempts; last error: Fly: 503')
    expect(email?.text).not.toContain('slow_operation')

    // Asked again: nothing new, so nothing raised and nothing sent.
    expect(await raiseSignals(h.db, now, tell)).toBe(0)
    expect(outbox.sent).toHaveLength(1)
  })

  test('kinds the setting leaves out raise nothing, and a setting with no notify emails nothing', async () => {
    await operation({ kind: 'start', steps: ['attempt', 'memory_lost', 'booting'], took: 40 * SECOND_MS })
    installTuning({
      ...deployed,
      joins: { reporter: 'off', signals: { slowOperation: { byKindS: { start: 90 } } } },
    })
    expect(await raiseSignals(h.db, now, tell)).toBe(0)
    installTuning({ ...deployed, joins: { reporter: 'off', signals: { wakeBooted: {} } } })
    expect(await raiseSignals(h.db, now, tell)).toBeGreaterThan(0)
    expect(outbox.sent).toHaveLength(0)
  })
})

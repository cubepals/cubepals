// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A queued sleep snapshot must not capture a server whose next session already started. */
import { expect, mock, test } from 'bun:test'
import type { Db, Tx } from '@blockly/db'
import type { MinecraftServer } from '../../../domain/server/server.ts'
import type { Slug } from '../../../domain/server/slug.ts'
import type { RuntimeHandle } from '../../ports/runtime.ts'
import type { OperationContext } from '../runner.ts'
import { backingUp } from './backups.ts'

function fixture(status: 'running' | 'stopped', trigger: 'sleep' | 'manual') {
  const at = new Date('2026-01-01T00:00:00Z')
  const server: MinecraftServer = {
    id: 'server',
    ownerId: 'owner',
    name: 'Our world',
    description: '',
    icon: null,
    ownIcon: null,
    tags: [],
    slug: 'our-world' as Slug,
    inviteCode: 'invite',
    regionKey: 'local',
    memoryTier: '3g',
    lifecycle: { status, failure: null, stopReason: status === 'stopped' ? 'idle' : null },
    desiredRevisionId: 'revision',
    activeWorldId: 'world',
    version: 1,
    createdAt: at,
    expiresAt: null,
    lastActiveAt: at,
    storedAt: null,
    notLoaded: [],
    deletedAt: null,
    purgeAfter: null,
  }
  const unexpected = async (): Promise<never> => {
    throw new Error('A rejected restore point must not touch its world')
  }
  const context: OperationContext = {
    server,
    op: {
      id: 'operation',
      serverId: server.id,
      kind: 'backup',
      status: 'running',
      input: { trigger },
      requestedBy: 'system',
      idempotencyKey: 'queued-backup',
      step: null,
      error: null,
      detail: null,
      startedAt: at,
      finishedAt: null,
      createdAt: at,
    },
    step: unexpected,
    mark: unexpected,
    reached: () => null,
    stillApplies: unexpected,
  }
  const tx = {} as Tx
  const transaction = mock(async (work: (value: Tx) => Promise<unknown>) => work(tx))
  const standingCheck = new Error('The standing must be checked before capturing a world')
  const policy = mock(async () => {
    throw standingCheck
  })
  const capture = mock(unexpected)
  const handler = backingUp({
    db: { transaction } as unknown as Db,
    policy: { check: policy },
    events: { publish: unexpected },
    archives: null,
    backups: { enforceRetention: unexpected },
    bindingOf: async () => ({
      serverId: server.id,
      provider: 'fake',
      handle: 'handle' as RuntimeHandle,
      foreign: false,
      placementRegionKey: 'local',
      applied: {
        revisionId: 'revision',
        worldId: 'world',
        memoryTier: '3g',
        regionKey: 'local',
        specDigest: 'digest',
      },
      observed: null,
      moveTo: null,
    }),
    capture,
    pack: unexpected,
  }).backup
  return { handler, context, transaction, tx, policy, capture, standingCheck }
}

test('a sleep backup queued before the server woke is cancelled without inspecting standing or touching its world', async () => {
  const { handler, context, transaction, policy, capture } = fixture('running', 'sleep')
  await expect(handler.run(context)).resolves.toEqual({
    status: 'cancelled',
    reason: 'The server woke before its restore point was taken.',
  })
  expect(transaction).not.toHaveBeenCalled()
  expect(policy).not.toHaveBeenCalled()
  expect(capture).not.toHaveBeenCalled()
  expect(context.server.lifecycle.status).toBe('running')
})

for (const [status, trigger] of [
  ['stopped', 'sleep'],
  ['running', 'manual'],
  ['stopped', 'manual'],
] as const) {
  test(`a ${trigger} backup of a ${status} server continues to the standing check`, async () => {
    const { handler, context, transaction, tx, policy, capture, standingCheck } = fixture(status, trigger)
    await expect(handler.run(context)).rejects.toBe(standingCheck)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(policy).toHaveBeenCalledWith(tx, context.server.ownerId, { kind: 'snapshot_backup' })
    expect(capture).not.toHaveBeenCalled()
  })
}

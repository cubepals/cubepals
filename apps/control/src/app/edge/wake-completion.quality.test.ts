// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server can accept joins while its wake operation still finishes. Kept and own addresses
 * name that same operation until it settles, then route to the same server without another wake.
 * A barrier delays only the real operation's final write; no response or database row is invented.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { Slug } from '../../domain/server/slug.ts'
import { type Harness, startHarness } from '../../testing/harness.ts'
import * as operations from '../operations/persistence.ts'

describe('ready joins while a wake operation finishes', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  test('kept and own addresses share the pending wake, then omit it after completion', async () => {
    const owner = await h.user()
    const server = await h.create(owner, { name: 'Arcade' })
    await h.db
      .update(schema.minecraftServers)
      .set({ slug: 'arcade' as Slug })
      .where(eq(schema.minecraftServers.id, server.id))
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(owner, server.id, randomUUID(), 'idle')
    await h.until(server.id, 'stopped')
    await h.settled(server.id)

    const reached = Promise.withResolvers<void>()
    const continueCompletion = Promise.withResolvers<void>()
    const originalFinish = operations.finishOperation
    let activeStart: string | undefined
    const finishing = spyOn(operations, 'finishOperation').mockImplementation(async (...args) => {
      const operation = await operations.loadOperation(args[0], args[1])
      if (
        operation?.serverId === server.id &&
        operation.kind === 'start' &&
        operation.requestedBy === 'system:wake'
      ) {
        activeStart = operation.id
        reached.resolve()
        await continueCompletion.promise
      }
      return originalFinish(...args)
    })
    const pending: Array<ReturnType<typeof h.app.edge.wake>> = []
    const deadline = setTimeout(() => {
      reached.reject(new Error('The real wake did not reach operation completion'))
      continueCompletion.resolve()
    }, 10_000)
    try {
      const waking = h.app.edge.wake('sunset-valley.play.test')
      pending.push(waking)
      await reached.promise
      clearTimeout(deadline)
      const kept = await waking
      expect(kept.outcome).toBe('ready')
      if (kept.outcome !== 'ready') throw new Error('The kept address did not become ready')
      if (activeStart === undefined) throw new Error('No wake operation reached completion')
      expect(kept.destination).toContain(':')
      expect(kept.wakeOperationId).toBe(activeStart)
      expect((await h.server(server.id)).lifecycle.status).toBe('running')
      expect((await operations.loadOperation(h.db, activeStart))?.status).toBe('running')

      const following = h.app.edge.wake('arcade.play.test')
      pending.push(following)
      expect(await following).toEqual({
        outcome: 'ready',
        destination: kept.destination,
        wakeOperationId: activeStart,
      })

      continueCompletion.resolve()
      await h.settled(server.id)
      expect(await h.app.edge.wake('arcade.play.test')).toEqual({
        outcome: 'ready',
        destination: kept.destination,
      })
      expect(
        (await h.operations(server.id))
          .filter((operation) => operation.kind === 'start')
          .map(({ id, status }) => ({ id, status })),
      ).toEqual([{ id: activeStart, status: 'succeeded' }])
    } finally {
      clearTimeout(deadline)
      continueCompletion.resolve()
      await Promise.allSettled(pending)
      finishing.mockRestore()
    }
  }, 60_000)
})

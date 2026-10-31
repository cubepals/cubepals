// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Concurrent joins share work, but never another player's refusal. Real eligibility reads and
 * starts are held behind explicit barriers, so both request orderings exercise the same contract
 * regardless of database latency. No elapsed delay decides when the second join is waiting.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { type Harness, startHarness } from '../../testing/harness.ts'
import * as operations from '../operations/persistence.ts'
import * as usage from '../servers/usage.ts'
import { tuning } from '../tuning.ts'

const PLAYER = '203.0.113.7'
const STRANGER = '198.51.100.9'

describe('sharing a wake with different eligibility', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h?.close()
  })

  const sleepingAtAllowance = async () => {
    const owner = await h.user()
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    const player = { uuid: randomUUID(), name: 'Alex' }
    await usage.replacePresence(h.db, server.id, [player], new Date())
    const hostname = `${server.slug}.play.test`
    await h.app.edge.recordSession({
      edgeId: 'shared-wake-test',
      hostname,
      event: 'disconnect',
      player,
      address: PLAYER,
      at: new Date().toISOString(),
    })
    await usage.replacePresence(h.db, server.id, [], new Date())
    await h.app.servers.stop(owner, server.id, randomUUID(), 'idle')
    await h.until(server.id, 'stopped')
    await h.settled(server.id)

    const allowance = tuning().abuse.wakesPerHour
    for (let i = 1; i <= allowance; i++) {
      const startedAt = new Date(Date.now() - (i * HOUR_MS) / (allowance + 2))
      await h.db.insert(schema.powerIntervals).values({
        serverId: server.id,
        memoryTier: '3g',
        startedAt,
        stoppedAt: new Date(startedAt.getTime() + MINUTE_MS),
        woken: true,
        joinedAt: null,
      })
    }
    return { id: server.id, hostname, allowance }
  }

  for (const [playerFirst, name] of [
    [false, "a known player is reconsidered after sharing a stranger's denied wake"],
    [true, "a stranger shares the known player's successful wake without another start"],
  ] as const) {
    test(name, async () => {
      const { id, hostname, allowance } = await sleepingAtAllowance()
      const before = (await h.operations(id)).filter((operation) => operation.kind === 'start').length
      const request = new AsyncLocalStorage<'leader' | 'follower'>()
      const firstPaused = Promise.withResolvers<void>()
      const continueFirst = Promise.withResolvers<void>()
      const followerRead = Promise.withResolvers<void>()
      const originalAllowance = usage.unjoinedWakes
      const originalOpen = operations.openOfKinds
      const originalStart = h.app.servers.start.bind(h.app.servers)
      const allowanceRead = spyOn(usage, 'unjoinedWakes').mockImplementation(async (...args) => {
        const answer = await originalAllowance(...args)
        if (!playerFirst && request.getStore() === 'leader' && args[1] === id) {
          expect(answer).toBe(allowance)
          firstPaused.resolve()
          await continueFirst.promise
        }
        return answer
      })
      const restartRead = spyOn(operations, 'openOfKinds').mockImplementation(async (...args) => {
        const answer = await originalOpen(...args)
        if (request.getStore() === 'follower') followerRead.resolve()
        return answer
      })
      const start = spyOn(h.app.servers, 'start').mockImplementation(async (...args) => {
        if (playerFirst && request.getStore() === 'leader' && args[1] === id) {
          firstPaused.resolve()
          await continueFirst.promise
        }
        return originalStart(...args)
      })
      const pending: Array<ReturnType<typeof h.app.edge.wake>> = []
      try {
        const first = request.run('leader', () =>
          h.app.edge.wake(hostname, true, 'Alex', playerFirst ? PLAYER : STRANGER),
        )
        pending.push(first)
        await firstPaused.promise
        const following = request.run('follower', () =>
          h.app.edge.wake(hostname, true, 'Alex', playerFirst ? STRANGER : PLAYER),
        )
        pending.push(following)
        await followerRead.promise
        // After the restart lookup, only promise continuations remain before sharing the wake.
        // An event-loop checkpoint drains them while the leader's real result is still held.
        await nextTurn()
        continueFirst.resolve()

        const [leader, follower] = await Promise.all([first, following])
        if (playerFirst) {
          expect(leader).toMatchObject({ outcome: 'ready' })
          expect(follower).toMatchObject({ outcome: 'ready' })
        } else {
          expect(leader).toEqual({ outcome: 'asleep' })
          expect(follower).toMatchObject({ outcome: 'ready' })
        }
        expect(start).toHaveBeenCalledTimes(1)
        await h.settled(id)
        expect((await h.server(id)).lifecycle.status).toBe('running')
        expect((await h.operations(id)).filter((operation) => operation.kind === 'start')).toHaveLength(
          before + 1,
        )
      } finally {
        continueFirst.resolve()
        await Promise.allSettled(pending)
        allowanceRead.mockRestore()
        restartRead.mockRestore()
        start.mockRestore()
        request.disable()
      }
    }, 60_000)
  }
})

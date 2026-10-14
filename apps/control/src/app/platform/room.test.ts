// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Room for new servers, end to end on Postgres and the fake runtime: a create with no room is
 * refused at once with nothing written, creates close by themselves for free plans first and then
 * for everyone, and open again once room frees, never past an operator's own close. The servers
 * people already have come first: their wakes get through while creates are closed, a Plus wake
 * goes ahead of a free one in the line, and every create waits behind both. While room is tight,
 * a free server nobody is on sleeps sooner.
 *
 * Six may run at once, two of them kept for wakes, so creates fill four; free plans half of that,
 * and room is tight from three running. Each describe's tests share one platform, in order, each
 * starting from where the last left it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { count, eq, sql } from 'drizzle-orm'
import { FULL } from '../../domain/policy/policy.ts'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { IDLE_GRACE_MS } from '../operations/schedules.ts'
import { installTuning, tuning } from '../tuning.ts'
import { loadCreatesFull } from './persistence.ts'

const was = tuning()

/** A platform where six run at once, with the people on it and each one's server by name. */
async function platform() {
  installTuning({ ...was, capacity: { freeShare: 0.5, tightShare: 0.5, tightIdleMinutes: 1 } })
  const h = await startHarness({ controls: { maxServers: 20, maxRunningServers: 6 } })
  const owned = new Map<string, { owner: UserActor; id: string }>()
  const of = (who: string) => {
    const server = owned.get(who)
    if (server === undefined) throw new Error(`${who} has no server`)
    return server
  }
  const settled = async (id: string, status: 'running' | 'stopped') => {
    await h.until(id, status)
    await h.settled(id)
  }
  return {
    h,
    of,
    running: async (who: string, plan = 'free') => {
      const owner = await h.user(who, plan)
      const { id } = await h.create(owner, { name: who })
      await settled(id, 'running')
      owned.set(who, { owner, id })
    },
    stop: async (who: string) => {
      await h.app.servers.stop(of(who).owner, of(who).id, randomUUID())
      await settled(of(who).id, 'stopped')
    },
    start: async (who: string) => {
      await h.app.servers.start(of(who).owner, of(who).id, randomUUID())
      await settled(of(who).id, 'running')
    },
    creating: async (owner: UserActor) =>
      (await h.app.accountQueries.overview(owner)).features.find((f) => f.feature === 'create_server'),
    recorded: async (action: string) =>
      (await h.db.select({ n: count() }).from(schema.auditLog).where(eq(schema.auditLog.action, action)))[0]
        ?.n,
    close: async () => {
      installTuning(was)
      await h.close()
    },
  }
}

describe.skipIf(!hasDatabase)('room for new servers', () => {
  let p: Awaited<ReturnType<typeof platform>>

  beforeAll(async () => {
    p = await platform()
  }, 30_000)

  afterAll(() => p.close())

  test('once only the paid share is left, a free person is told it is full and a Plus person still gets a server', async () => {
    // A free player's server, stopped: it holds no running place, and wakes later.
    await p.running('Sleeper')
    await p.stop('Sleeper')
    await p.running('Plus A', 'plus')
    await p.running('Plus B', 'plus')
    const free = await p.h.user('Too Late')
    expect(await p.creating(free)).toMatchObject({ available: false, code: 'platform_full' })
    await expect(p.h.create(free, { name: 'Too Late' })).rejects.toThrow(FULL)
    await p.h.app.policy.room.settle()
    expect(await loadCreatesFull(p.h.db)).toMatchObject({ for: 'free', because: 'running' })
    expect(await p.creating(await p.h.user('Plus C', 'plus'))).toEqual({
      feature: 'create_server',
      available: true,
    })
    await p.running('Plus C', 'plus')
  }, 60_000)

  test('a create with no room is refused before anything is written, and creates close for everyone', async () => {
    await p.running('Plus D', 'plus')
    const late = await p.h.user('Plus E', 'plus')
    const written = async () => ({
      servers: (await p.h.db.select({ n: count() }).from(schema.minecraftServers))[0]?.n,
      operations: (await p.h.db.select({ n: count() }).from(schema.serverOperations))[0]?.n,
      created: await p.recorded('server.created'),
    })
    const before = await written()
    // The page says so before anyone fills anything in.
    expect(await p.creating(late)).toMatchObject({ available: false, code: 'platform_full' })
    await expect(p.h.create(late, { name: 'Plus E' })).rejects.toMatchObject({
      code: 'platform_full',
      message: FULL,
    })
    expect(await written()).toEqual(before)
    await p.h.app.policy.room.settle()
    expect(await loadCreatesFull(p.h.db)).toMatchObject({ for: 'everyone', because: 'running' })
    expect(await p.recorded('platform.creates_closed')).toBe(2)
  }, 60_000)

  test('a wake still gets through while creates are closed', async () => {
    await p.start('Sleeper')
    await p.h.app.policy.room.settle()
    expect((await loadCreatesFull(p.h.db))?.for).toBe('everyone')
  }, 60_000)

  test('creates open again by themselves once room frees, and never past an operator’s own close', async () => {
    await p.h.db.update(schema.platformControls).set({ provisioningEnabled: false })
    for (const who of ['Sleeper', 'Plus D', 'Plus C', 'Plus B']) await p.stop(who)
    await p.h.app.policy.room.settle()
    expect(await loadCreatesFull(p.h.db)).toBeNull()
    expect(await p.recorded('platform.creates_reopened')).toBe(1)
    // Room is back, and the operator's switch is as they left it.
    const late = await p.h.user('Plus F', 'plus')
    expect(await p.creating(late)).toMatchObject({ available: false, code: 'platform_paused' })
    await p.h.db.update(schema.platformControls).set({ provisioningEnabled: true })
    expect(await p.creating(late)).toEqual({ feature: 'create_server', available: true })
  }, 90_000)
})

describe.skipIf(!hasDatabase)('the servers people already have, first', () => {
  let p: Awaited<ReturnType<typeof platform>>

  beforeAll(async () => {
    p = await platform()
  }, 30_000)

  afterAll(() => p.close())

  test('a Plus wake goes ahead of a free one in the line, and every create behind both', async () => {
    await p.running('Free')
    await p.running('Plus', 'plus')
    for (const who of ['Free', 'Plus']) await p.stop(who)
    for (const who of ['Free', 'Plus']) await p.start(who)
    const line = async (who: string) => {
      const operations = await p.h.operations(p.of(who).id)
      return Promise.all(
        operations.map(async (op) => {
          const [job] = (
            await p.h.db.execute<{ priority: number }>(
              sql`select priority from pgboss.job where id = ${op.id}`,
            )
          ).rows
          return [op.kind, job?.priority]
        }),
      )
    }
    expect(await line('Free')).toEqual([
      ['provision', -1],
      ['stop', 0],
      ['start', 1],
    ])
    expect(await line('Plus')).toEqual([
      ['provision', -1],
      ['stop', 0],
      ['start', 2],
    ])
  }, 60_000)

  test('while room is tight, a free server nobody is on sleeps sooner, and a Plus one keeps its time', async () => {
    await p.running('Third', 'plus')
    // Two minutes empty, looked at once the restart grace is over: seven minutes in all.
    const empty = async (who: string) => {
      const { id } = p.of(who)
      const longer = sql`now() - interval '2 minutes'`
      await p.h.db
        .update(schema.powerIntervals)
        .set({ startedAt: longer })
        .where(eq(schema.powerIntervals.serverId, id))
      await p.h.db.delete(schema.serverActivity).where(eq(schema.serverActivity.serverId, id))
      return p.h.app.schedules.evaluateIdle(await p.h.server(id), new Date(Date.now() + IDLE_GRACE_MS))
    }
    expect(await empty('Plus')).toBe('recently_active')
    expect(await empty('Free')).toBe('stopped')
    expect((await p.h.until(p.of('Free').id, 'stopped')).lifecycle.stopReason).toBe('idle')
    // With room to spare, the same free server keeps its plan's whole idle time.
    await p.stop('Third')
    await p.start('Free')
    expect(await empty('Free')).toBe('recently_active')
  }, 90_000)
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server someone played lately whose stop was meant as a sleep and couldn't be one (someone on
 * it as it went, its files not written through): the `stale-sleep` pass starts it once in the
 * background after the stop has settled, so it ends asleep with its memory and its next join
 * resumes. Which stops it leaves alone, that it comes after the sleeping servers the pass already
 * refreshes, and that a sleep refused a second time is not tried again. Against the fake runtime
 * with its sleeps switched on, as FLY_SUSPEND switches Fly's.
 *
 * The sleeping servers' own refreshes are `stale-sleep.test.ts`'s.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor, UserActor } from '../actor.ts'
import * as metered from '../billing/chip-in-meter.ts'
import { loadRevision } from '../servers/persistence.ts'
import { KEPT_PLAYED_MS, PLAYED_MS, SETTLED_MS } from './schedules/stale-sleep.ts'
import { IDLE_GRACE_MS, WAKE_PROBATION_MS } from './schedules.ts'

const operations = schema.serverOperations
let h: Harness

beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness()
  h.runtime.sleeps.on = true
}, 30_000)

afterEach(() => {
  if (!hasDatabase) return
  h.runtime.sleeps.on = true
  h.runtime.sleeps.refused = false
  h.minecraft.bootTakes(0)
})

afterAll(async () => {
  await h?.close()
})

/** The steps the server's last operation of a kind went through, in order, and its key. */
async function last(id: string, kind: 'start' | 'stop'): Promise<{ steps: string[]; key: string }> {
  const [row] = await h.db
    .select({ steps: operations.steps, key: operations.idempotencyKey })
    .from(operations)
    .where(and(eq(operations.serverId, id), eq(operations.kind, kind)))
    .orderBy(desc(operations.createdAt))
    .limit(1)
  return { steps: (row?.steps ?? []).map((entry) => entry.step), key: row?.key ?? '' }
}
const lastStart = (id: string) => last(id, 'start')
/** Whether the server's newest start is a refresh that keeps it ready, by its key. */
const keptReady = async (id: string) => (await lastStart(id)).key.startsWith('start:refresh:ready:')
const resumed = (steps: string[]) => steps.includes('resuming') && !steps.includes('booting')

const running = async () => {
  const owner = await h.user(undefined, 'plus')
  const created = await h.create(owner)
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return { owner, id: created.id, slug: created.slug }
}
const stop = async (owner: UserActor, id: string, reason: 'user' | 'idle' | 'maintenance' = 'user') => {
  await h.app.servers.stop(owner, id, randomUUID(), reason)
  await h.until(id, 'stopped')
  await h.settled(id)
  return (await last(id, 'stop')).steps
}
const wake = async (owner: UserActor, id: string) => {
  await h.app.servers.start(owner, id, randomUUID())
  await h.until(id, 'running')
  await h.settled(id)
  return (await lastStart(id)).steps
}
const up = async (id: string) => {
  await h.until(id, 'running')
  await h.settled(id)
}
/** Someone last played the server at `at`, as its own reading of who is on records it. */
const playedAt = (id: string, at: Date) =>
  h.db
    .insert(schema.serverActivity)
    .values({ serverId: id, lastPlayerAt: at })
    .onConflictDoUpdate({ target: schema.serverActivity.serverId, set: { lastPlayerAt: at } })
/**
 * Its owner's Stop with a player still on, a minute after someone last played: the sleep is
 * refused, so nobody is frozen with it, and it is stopped for real.
 */
const stoppedWithSomeoneOn = async (owner: UserActor, id: string) => {
  h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
  expect(await stop(owner, id)).toContain('players_on')
  expect(h.runtime.machine(id)?.state).toBe('stopped')
  await playedAt(id, new Date(Date.now() - MINUTE_MS))
}
/** One pass of the schedule as it runs, `aheadMs` from now: a stop has to have settled by then. */
const pass = (aheadMs = 0, limit = 50) =>
  h.app.schedules.staleSleep({ limit, now: new Date(Date.now() + aheadMs) })
/** A pass once every stop made so far has settled. */
const settledPass = (limit?: number) => pass(SETTLED_MS + MINUTE_MS, limit)
/** The idle check past a woken run's probation with nobody on: the stop it asks for. */
const idlesUnjoined = async (id: string) => {
  const late = new Date(Date.now() + IDLE_GRACE_MS + WAKE_PROBATION_MS + 1_000)
  expect(await h.app.schedules.evaluateIdle(await h.server(id), late)).toBe('nobody_joined')
  await h.until(id, 'stopped')
  await h.settled(id)
}

describe.skipIf(!hasDatabase)('stale-sleep, in the order it refreshes', () => {
  test('a wake that would boot, then memory kept too long, then a sleep that was refused', async () => {
    const boots = await running()
    await stop(boots.owner, boots.id, 'idle')
    const settings = (await loadRevision(h.db, (await h.server(boots.id)).desiredRevisionId)).settings
    await h.app.revisions.changeSettings(
      boots.owner,
      boots.id,
      { ...settings, difficulty: 'hard' },
      randomUUID(),
    )
    await h.settled(boots.id)

    const kept = await running()
    await stop(kept.owner, kept.id, 'idle')
    expect(h.runtime.machine(kept.id)?.state).toBe('suspended')
    await playedAt(kept.id, new Date())

    const refused = await running()
    await stoppedWithSomeoneOn(refused.owner, refused.id)

    // One a pass, an hour and more on: each pass takes the first the one before left.
    const ids = [boots.id, kept.id, refused.id]
    const started = async () => Promise.all(ids.map(keptReady))
    expect(await pass(2 * KEPT_PLAYED_MS, 1)).toBe(1)
    expect(await started()).toEqual([true, false, false])
    expect(await pass(2 * KEPT_PLAYED_MS, 1)).toBe(1)
    expect(await started()).toEqual([true, true, false])
    expect(await pass(2 * KEPT_PLAYED_MS, 1)).toBe(1)
    expect(await started()).toEqual([true, true, true])
    expect(await pass(2 * KEPT_PLAYED_MS, 1)).toBe(0)
    for (const id of ids) await up(id)
    // The first two as before: a boot on what it should run, and a resume of memory still there.
    expect((await lastStart(boots.id)).steps).toContain('changed:drift:env.DIFFICULTY')
    expect(resumed((await lastStart(kept.id)).steps)).toBe(true)
    expect((await lastStart(refused.id)).steps).toContain('booting')
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a server played lately whose sleep was refused', () => {
  test('is started in the background once its stop has settled, and its next join resumes', async () => {
    const { owner, id } = await running()
    // Someone really plays, as the server's own reading says, and is on when its owner presses Stop.
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    await h.app.schedules.presenceSync()
    expect(await stop(owner, id)).toContain('players_on')
    expect(h.runtime.machine(id)?.state).toBe('stopped')

    // Its owner's Stop is not followed by a start the next minute: it stays as they left it.
    await pass()
    await pass(SETTLED_MS / 2)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    expect(await keptReady(id)).toBe(false)

    h.minecraft.bootTakes(1_500)
    try {
      expect(await settledPass()).toBe(1)
      // While it boots, its page is told what the start is, as of any refresh that keeps it ready.
      expect((await h.app.queries.get(owner, id)).activeOperation).toMatchObject({
        kind: 'start',
        refresh: true,
        keepsReady: true,
      })
      await h.until(id, 'running', 10_000)
    } finally {
      h.minecraft.bootTakes(0)
    }
    await h.settled(id)
    const refresh = await lastStart(id)
    expect(refresh.key).toStartWith('start:refresh:ready:')
    expect(refresh.key).not.toStartWith('start:refresh:ready:recorded:')
    expect(refresh.steps).toContain('booting')
    // A woken run nobody waits for: it counts toward no hours until someone joins it.
    const [run] = await h.db
      .select({ woken: schema.powerIntervals.woken, pinged: schema.powerIntervals.pinged })
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, id))
      .orderBy(desc(schema.powerIntervals.startedAt))
      .limit(1)
    expect(run).toEqual({ woken: true, pinged: true })

    // Nobody joins: asleep after the probation, this time with its memory, and the next wake resumes.
    await idlesUnjoined(id)
    expect((await last(id, 'stop')).steps).toContain('slept')
    expect(h.runtime.machine(id)?.state).toBe('suspended')
    expect(resumed(await wake(owner, id))).toBe(true)
  }, 90_000)

  test('a player who joins while it starts plays, and the stop of their run is refreshed in its turn', async () => {
    const { owner, id, slug } = await running()
    await stoppedWithSomeoneOn(owner, id)
    h.minecraft.bootTakes(1_500)
    try {
      expect(await settledPass()).toBe(1)
      // The player's wake finds it on its way up, and is let in when it is.
      await h.app.edge.wake(`${slug}.play.test`)
      await h.until(id, 'running', 10_000)
    } finally {
      h.minecraft.bootTakes(0)
    }
    await h.settled(id)
    const first = (await lastStart(id)).key
    expect(first).toStartWith('start:refresh:ready:')
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    await h.app.schedules.presenceSync()
    const late = new Date(Date.now() + IDLE_GRACE_MS + WAKE_PROBATION_MS + 1_000)
    expect(await h.app.schedules.evaluateIdle(await h.server(id), late)).not.toBe('nobody_joined')
    expect((await h.server(id)).lifecycle.status).toBe('running')

    // Their run ends as the one before did. It is a run someone played, so its stop is refreshed too.
    expect(await stop(owner, id)).toContain('players_on')
    await settledPass()
    expect((await lastStart(id)).key).not.toBe(first)
    expect(await keptReady(id)).toBe(true)
    await up(id)
  }, 90_000)
})

describe.skipIf(!hasDatabase)('a stop that is no refused sleep of a server played lately', () => {
  test('one nobody played lately is left as it stopped', async () => {
    const { owner, id } = await running()
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    expect(await stop(owner, id)).toContain('players_on')
    // Never played, by the server's own reading; then last played longer ago than counts.
    await settledPass()
    expect(await keptReady(id)).toBe(false)
    await playedAt(id, new Date(Date.now() - PLAYED_MS - HOUR_MS))
    await settledPass()
    expect(await keptReady(id)).toBe(false)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')

    await playedAt(id, new Date(Date.now() - HOUR_MS))
    await settledPass()
    expect(await keptReady(id)).toBe(true)
    await up(id)
  }, 90_000)

  test('a stop that was never to be a sleep, or that its runtime made one, is left', async () => {
    const { owner, id } = await running()
    const left = async (mark: string, steps: string[]) => {
      expect(steps).toContain(mark)
      expect(h.runtime.machine(id)?.state).toBe('stopped')
      await playedAt(id, new Date(Date.now() - MINUTE_MS))
      const before = (await lastStart(id)).key
      await settledPass()
      expect((await lastStart(id)).key).toBe(before)
      expect((await h.server(id)).lifecycle.status).toBe('stopped')
    }
    // Stopped for a reason of its own, with someone on or not: a stop, whoever was there.
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    await left('stop_reason', await stop(owner, id, 'maintenance'))

    // A runtime that only stops.
    await wake(owner, id)
    h.runtime.sleeps.on = false
    await left('no_sleep', await stop(owner, id))
    h.runtime.sleeps.on = true

    // One that sleeps and didn't this time: its switch reads the same, and a second sleep would go the same way.
    await wake(owner, id)
    h.runtime.sleeps.refused = true
    await left('runtime_stopped', await stop(owner, id))
  }, 90_000)
})

describe.skipIf(!hasDatabase)(
  'a refused sleep with something asked of the server since, or still being written',
  () => {
    test('one started or stopped again since, or restored or moved, is left', async () => {
      const { owner, id } = await running()
      await stoppedWithSomeoneOn(owner, id)
      // Its owner starts it, and it sleeps as ever: asleep with its memory, and nothing to make up for.
      expect(await wake(owner, id)).toContain('booting')
      const theirs = (await lastStart(id)).key
      expect(await stop(owner, id)).toContain('slept')
      await settledPass()
      expect((await lastStart(id)).key).toBe(theirs)

      // Something else asked of it after the refused sleep, here a move: it stays as that left it.
      const other = await running()
      await stoppedWithSomeoneOn(other.owner, other.id)
      const move = randomUUID()
      await h.db.insert(operations).values({
        id: move,
        serverId: other.id,
        kind: 'relocate',
        status: 'succeeded',
        input: {},
        requestedBy: 'system:test',
        idempotencyKey: `relocate:${move}`,
      })
      await settledPass()
      expect(await keptReady(other.id)).toBe(false)
      await h.db.delete(operations).where(eq(operations.id, move))
      await settledPass()
      expect(await keptReady(other.id)).toBe(true)
      await up(other.id)
    }, 90_000)

    test('its start waits for the restore point its stop is writing: the copy is of the server as it stopped', async () => {
      const { owner, id } = await running()
      await stoppedWithSomeoneOn(owner, id)
      const backup = randomUUID()
      await h.db.insert(operations).values({
        id: backup,
        serverId: id,
        kind: 'backup',
        status: 'running',
        input: { trigger: 'sleep' },
        requestedBy: 'system:sleep',
        idempotencyKey: `backup:sleep:${backup}`,
      })
      await settledPass()
      expect(await keptReady(id)).toBe(false)
      await h.db.update(operations).set({ status: 'succeeded' }).where(eq(operations.id, backup))
      await settledPass()
      expect(await keptReady(id)).toBe(true)
      await up(id)
    }, 90_000)
  },
)

describe.skipIf(!hasDatabase)('a refused sleep is made up for once, on hours its owner has', () => {
  test('once a stop: a refresh whose own sleep is refused again is not tried again', async () => {
    const { owner, id } = await running()
    await stoppedWithSomeoneOn(owner, id)
    await settledPass()
    await up(id)
    const refresh = (await lastStart(id)).key
    expect(refresh).toStartWith('start:refresh:ready:')

    // Nobody joins, and this time its files can't be written through: stopped for real again.
    const exec = h.runtime.exec.bind(h.runtime)
    const unsynced = spyOn(h.runtime, 'exec').mockImplementation((handle, command, timeout) =>
      command[0] === 'sync'
        ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'sync: Input/output error' })
        : exec(handle, command, timeout),
    )
    try {
      await idlesUnjoined(id)
    } finally {
      unsynced.mockRestore()
    }
    expect((await last(id, 'stop')).steps).toContain('unsynced')
    expect(h.runtime.machine(id)?.state).toBe('stopped')

    // Its sleep was refused, someone played it lately, and nothing was asked of it since: all as
    // before, but for whose run the stop ended. However long it waits, no second start.
    for (const aheadMs of [SETTLED_MS + MINUTE_MS, 2 * KEPT_PLAYED_MS, 8 * HOUR_MS, PLAYED_MS - HOUR_MS]) {
      await pass(aheadMs)
      expect((await lastStart(id)).key).toBe(refresh)
    }
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    // A start somebody asks for is theirs as ever.
    expect(await wake(owner, id)).toContain('booting')
  }, 90_000)

  test('a start that fails is not tried again', async () => {
    const { owner, id } = await running()
    await stoppedWithSomeoneOn(owner, id)
    h.minecraft.breakOn(() => 'Failed to load the world')
    try {
      expect(await settledPass()).toBeGreaterThan(0)
      await h.until(id, 'failed')
      await h.settled(id)
    } finally {
      h.minecraft.breakOn(() => null)
    }
    const failed = (await lastStart(id)).key
    expect(failed).toStartWith('start:refresh:ready:')
    await settledPass()
    await pass(8 * HOUR_MS)
    expect((await lastStart(id)).key).toBe(failed)
    expect((await h.server(id)).lifecycle.status).toBe('failed')
  }, 90_000)

  test('nothing starts on hours its owner doesn’t have, or for an owner who can’t start it', async () => {
    const { owner, id } = await running()
    await stoppedWithSomeoneOn(owner, id)
    const month = spyOn(metered, 'meteredMonth').mockResolvedValue({
      start: new Date(Date.now() - HOUR_MS),
      next: new Date(Date.now() + HOUR_MS),
      included: 10,
      carried: 2,
      units: 12,
    })
    try {
      await settledPass()
      expect(await keptReady(id)).toBe(false)
    } finally {
      month.mockRestore()
    }

    const admin: Actor = { kind: 'admin', userId: (await h.user('Admin')).userId }
    await h.app.accounts.suspend(admin, owner.userId, 'testing refused sleeps')
    await settledPass()
    expect(await keptReady(id)).toBe(false)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')

    // Asked again at each pass while the stop is recent, so once its owner may start it, it is.
    await h.app.accounts.reinstate(admin, owner.userId)
    await settledPass()
    expect(await keptReady(id)).toBe(true)
    await up(id)
  }, 90_000)
})

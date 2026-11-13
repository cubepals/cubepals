// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server asleep whose wake would boot: the wake says which part of its resume key changed, and
 * the `stale-sleep` pass refreshes it first, in the background, so the player's own wake resumes.
 * What it leaves alone, how often, a join that arrives while it refreshes, and memory kept so long
 * the provider may have dropped it unseen. Against the fake
 * runtime with its sleeps switched on, as FLY_SUSPEND switches Fly's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DAY_MS, HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import { DATA_DIR } from '../../minecraft/jars.ts'
import { CACHE_STATE } from '../../minecraft/start-cache.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import { AGAIN_MS, KEPT_PLAYED_MS, PLAYED_MS } from './schedules/stale-sleep.ts'
import { IDLE_GRACE_MS, WAKE_PROBATION_MS } from './schedules.ts'

const operations = schema.serverOperations
let h: Harness

beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness()
  h.runtime.sleeps.on = true
}, 30_000)

afterEach(() => {
  if (hasDatabase) h.runtime.sleeps.on = true
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

const running = async () => {
  const owner = await h.user(undefined, 'plus')
  const created = await h.create(owner)
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return { owner, id: created.id, slug: created.slug }
}
const asleep = async (owner: UserActor, id: string) => {
  await h.app.servers.stop(owner, id, randomUUID(), 'idle')
  await h.until(id, 'stopped')
  await h.settled(id)
  expect(h.runtime.machine(id)?.state).toBe('suspended')
}
const harder = async (owner: UserActor, id: string, difficulty: 'hard' | 'peaceful' = 'hard') => {
  const settings = (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings
  await h.app.revisions.changeSettings(owner, id, { ...settings, difficulty }, randomUUID())
  await h.settled(id)
}
const wake = async (owner: UserActor, id: string) => {
  await h.app.servers.start(owner, id, randomUUID())
  await h.until(id, 'running')
  await h.settled(id)
  return (await lastStart(id)).steps
}
/** One pass, looking at servers however recently they fell asleep. */
const pass = (options: { limit?: number; now?: Date } = {}) =>
  h.app.schedules.staleSleep({ settledMs: 0, ...options })
/** Past a woken run's probation with nobody on: asleep again. */
const sleepsUnjoined = async (id: string) => {
  const late = new Date(Date.now() + IDLE_GRACE_MS + WAKE_PROBATION_MS + 1_000)
  expect(await h.app.schedules.evaluateIdle(await h.server(id), late)).toBe('nobody_joined')
  await h.until(id, 'stopped')
  await h.settled(id)
  expect(h.runtime.machine(id)?.state).toBe('suspended')
}
const resumed = (steps: string[]) => steps.includes('resuming') && !steps.includes('booting')

describe.skipIf(!hasDatabase)('a wake that boots says why', () => {
  test('after other_spec, each part of the resume key that changed since it went to sleep', async () => {
    const { owner, id } = await running()
    await asleep(owner, id)
    await harder(owner, id)
    const steps = await wake(owner, id)
    expect(steps).toContain('booting')
    expect(steps).toContain('other_spec')
    expect(steps.filter((step) => step.startsWith('changed:'))).toEqual(['changed:drift:env.DIFFICULTY'])
    // And which machine it booted, kept after the provider forgets it.
    expect(steps.filter((step) => step.startsWith('machine:'))).toEqual([`machine:${id}/1`])

    // Asleep on what it now runs, its next wake resumes, and says nothing changed.
    await asleep(owner, id)
    const again = await wake(owner, id)
    expect(resumed(again)).toBe(true)
    expect(again.some((step) => step.startsWith('changed:'))).toBe(false)
  }, 60_000)
})

describe.skipIf(!hasDatabase)('stale-sleep', () => {
  test('a server asleep whose wake would boot is refreshed first, so the player’s wake resumes', async () => {
    const { owner, id } = await running()
    await asleep(owner, id)
    await harder(owner, id)
    expect(await pass()).toBe(1)
    await h.until(id, 'running')
    await h.settled(id)
    const refresh = await lastStart(id)
    // A refresh, and one nothing of its owner's asked for: its page says it is kept ready.
    expect(refresh.key).toStartWith('start:refresh:ready:')
    expect(refresh.steps).toContain('changed:drift:env.DIFFICULTY')
    expect(h.minecraft.playing(id).difficulty).toBe('hard')

    // Nobody joins: asleep again on the new settings, and the player's wake is a resume.
    await sleepsUnjoined(id)
    expect(resumed(await wake(owner, id))).toBe(true)
    expect(h.minecraft.playing(id).difficulty).toBe('hard')
  }, 90_000)

  test('one that would resume, or only just asleep, is left alone; a few a pass', async () => {
    const { owner, id } = await running()
    await asleep(owner, id)
    expect(await pass()).toBe(0)
    await harder(owner, id)
    // Just asleep: its sleep's restore point may still be writing.
    expect(await h.app.schedules.staleSleep()).toBe(0)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')

    const other = await running()
    await asleep(other.owner, other.id)
    await harder(other.owner, other.id)
    expect(await pass({ limit: 1 })).toBe(1)
    expect(await pass({ limit: 1 })).toBe(1)
    for (const server of [id, other.id]) {
      await h.until(server, 'running')
      await h.settled(server)
    }
  }, 90_000)

  test('a refresh is asked once in its window, whatever came of it', async () => {
    const { owner, id } = await running()
    await asleep(owner, id)
    await harder(owner, id)
    expect(await pass()).toBe(1)
    await h.until(id, 'running')
    await h.settled(id)
    await sleepsUnjoined(id)
    // Changed again soon after: left for a later pass, so a key that never settles can't wake it every ten minutes.
    await harder(owner, id, 'peaceful')
    expect(await pass()).toBe(0)
    expect(await pass({ now: new Date(Date.now() + AGAIN_MS + HOUR_MS) })).toBe(1)
    await h.until(id, 'running')
    await h.settled(id)
  }, 90_000)

  test('a player who joins while it refreshes plays, and it stays up for them', async () => {
    const { owner, id, slug } = await running()
    await asleep(owner, id)
    await harder(owner, id)
    h.minecraft.bootTakes(1_500)
    try {
      expect(await pass()).toBe(1)
      // The player's wake finds it on its way up, and is let in when it is.
      await h.app.edge.wake(`${slug}.play.test`)
      await h.until(id, 'running', 10_000)
    } finally {
      h.minecraft.bootTakes(0)
    }
    await h.settled(id)
    const uuid = randomUUID()
    h.minecraft.join(id, { uuid, name: 'Alex' })
    await h.app.schedules.presenceSync()
    const late = new Date(Date.now() + IDLE_GRACE_MS + WAKE_PROBATION_MS + 1_000)
    expect(await h.app.schedules.evaluateIdle(await h.server(id), late)).not.toBe('nobody_joined')
    expect((await h.server(id)).lifecycle.status).toBe('running')
  }, 60_000)
})

describe.skipIf(!hasDatabase)('stale-sleep, for memory kept too long to count on', () => {
  const refreshed = async (id: string) => (await lastStart(id)).key.startsWith('start:refresh:')
  const playedAt = (id: string, at: Date) =>
    h.db
      .insert(schema.serverActivity)
      .values({ serverId: id, lastPlayerAt: at })
      .onConflictDoUpdate({ target: schema.serverActivity.serverId, set: { lastPlayerAt: at } })

  test('memory dropped unseen is found before the player’s wake, where someone played lately', async () => {
    const { owner, id } = await running()
    await asleep(owner, id)
    await playedAt(id, new Date())
    // The provider drops what it kept, and goes on reading the machine asleep: nothing to read of it.
    h.runtime.sleeps.drop(id)
    expect(h.runtime.machine(id)?.state).toBe('suspended')
    await pass({ limit: 50, now: new Date(Date.now() + KEPT_PLAYED_MS / 2) })
    expect(await refreshed(id)).toBe(false)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')

    // A boot that takes longer than a resume is given to answer, as a real one does.
    h.minecraft.bootTakes(11_000)
    try {
      expect(await pass({ limit: 50, now: new Date(Date.now() + 2 * KEPT_PLAYED_MS) })).toBeGreaterThan(0)
      // While it boots, its page is told what the start is: a refresh that keeps it ready.
      expect((await h.app.queries.get(owner, id)).activeOperation).toMatchObject({
        kind: 'start',
        refresh: true,
        keepsReady: true,
      })
      await h.until(id, 'running', 30_000)
    } finally {
      h.minecraft.bootTakes(0)
    }
    await h.settled(id)
    expect(await refreshed(id)).toBe(true)
    // The refresh is the start that found the memory gone, with nobody waiting for its boot.
    expect((await lastStart(id)).steps).toEqual(expect.arrayContaining(['resuming', 'booting']))

    await sleepsUnjoined(id)
    expect(resumed(await wake(owner, id))).toBe(true)
  }, 120_000)

  test('one nobody played lately is left asleep, however long its memory has been kept', async () => {
    const { owner, id } = await running()
    await asleep(owner, id)
    // Never played, then last played longer ago than counts: a refresh would boot it for memory
    // that is gone again before anyone comes.
    await pass({ limit: 50, now: new Date(Date.now() + 3 * DAY_MS) })
    expect(await refreshed(id)).toBe(false)
    await playedAt(id, new Date(Date.now() - PLAYED_MS - HOUR_MS))
    await pass({ limit: 50, now: new Date(Date.now() + 3 * DAY_MS) })
    expect(await refreshed(id)).toBe(false)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
  }, 90_000)

  test('one played lately has its memory counted on for an hour: its players come back', async () => {
    const { owner, id } = await running()
    await asleep(owner, id)

    await playedAt(id, new Date())
    // Kept for less than the hour: still counted on.
    await pass({ limit: 50, now: new Date(Date.now() + KEPT_PLAYED_MS / 2) })
    expect(await refreshed(id)).toBe(false)
    expect(await pass({ limit: 50, now: new Date(Date.now() + 2 * KEPT_PLAYED_MS) })).toBeGreaterThan(0)
    await h.until(id, 'running')
    await h.settled(id)
    expect(await refreshed(id)).toBe(true)
    expect(resumed((await lastStart(id)).steps)).toBe(true)

    // Asleep again on memory just kept, and refreshed within the hour: left until that is an hour old too.
    await sleepsUnjoined(id)
    const before = (await lastStart(id)).key
    await pass({ limit: 50, now: new Date(Date.now() + KEPT_PLAYED_MS / 2) })
    expect((await lastStart(id)).key).toBe(before)
    await pass({ limit: 50, now: new Date(Date.now() + 2 * KEPT_PLAYED_MS) })
    expect((await lastStart(id)).key).not.toBe(before)
    await h.until(id, 'running')
    await h.settled(id)
  }, 120_000)
})

describe.skipIf(!hasDatabase)('a server whose Java records its start', () => {
  /** What the startup cache's script left on the server's volume: how far its cache got. */
  const cacheIs = (id: string, phase: 'recording' | 'made') => {
    const state = join(h.runtime.machine(id)?.dir ?? '', CACHE_STATE.replace(`${DATA_DIR}/`, ''))
    mkdirSync(dirname(state), { recursive: true })
    writeFileSync(state, `made-for\n${phase}\n`)
  }
  /** Asleep by a stop for its recording: stopped, and the stop says why. */
  const stoppedRecording = async (owner: UserActor, id: string) => {
    cacheIs(id, 'recording')
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)
    expect(h.runtime.machine(id)?.state).toBe('stopped')
    expect((await last(id, 'stop')).steps).toContain('recording')
  }
  /** One pass of the schedule, and whether the server's newest start is the one that follows a recording. */
  const followed = async (id: string) => {
    await h.app.schedules.recordedStarts(new Date(), 50)
    return (await lastStart(id)).key.startsWith('start:refresh:ready:recorded:')
  }

  test('its sleep is a stop for once, and a start nobody waits for puts it back to sleep with its memory', async () => {
    const { owner, id } = await running()
    // Stopped, so that its Java exits and writes what it recorded.
    await stoppedRecording(owner, id)

    expect(await followed(id)).toBe(true)
    await h.until(id, 'running')
    await h.settled(id)
    expect((await lastStart(id)).steps).toContain('booting')

    // The run that start began sleeps as ever, whatever its volume still says: one stop a recording.
    await sleepsUnjoined(id)
    expect((await last(id, 'stop')).steps).toContain('slept')
    const before = (await lastStart(id)).key
    await h.app.schedules.recordedStarts(new Date(), 50)
    expect((await lastStart(id)).key).toBe(before)
    expect(resumed(await wake(owner, id))).toBe(true)
  }, 120_000)

  test('its start waits for the restore point its sleep is writing: the copy is of the server as it stopped', async () => {
    const { owner, id } = await running()
    await stoppedRecording(owner, id)
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
    expect(await followed(id)).toBe(false)
    await h.db.update(operations).set({ status: 'succeeded' }).where(eq(operations.id, backup))
    expect(await followed(id)).toBe(true)
    await h.until(id, 'running')
    await h.settled(id)
  }, 90_000)

  test('its owner’s own stop is a sleep as ever: it stays as they left it, and nothing starts it', async () => {
    const { owner, id } = await running()
    cacheIs(id, 'recording')
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    expect(h.runtime.machine(id)?.state).toBe('suspended')
    expect((await last(id, 'stop')).steps).toContain('slept')
    expect(await followed(id)).toBe(false)
    // The sleep nobody asked for, after its next run, is the one that lets the recording be written.
    expect(resumed(await wake(owner, id))).toBe(true)
    await stoppedRecording(owner, id)
  }, 90_000)

  test('a start its owner or a player asks first is theirs, and nothing follows it', async () => {
    const { owner, id } = await running()
    await stoppedRecording(owner, id)
    cacheIs(id, 'made')
    expect(await wake(owner, id)).toContain('booting')
    await asleep(owner, id)
    expect(await followed(id)).toBe(false)
  }, 90_000)

  test('one whose Java reads its cache, or has none, sleeps as ever', async () => {
    const { owner, id } = await running()
    await asleep(owner, id)
    expect((await last(id, 'stop')).steps).toContain('slept')
    expect(resumed(await wake(owner, id))).toBe(true)
    cacheIs(id, 'made')
    await asleep(owner, id)
    expect(await followed(id)).toBe(false)
  }, 90_000)
})

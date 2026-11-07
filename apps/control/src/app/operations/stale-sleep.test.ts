// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server asleep whose wake would boot: the wake says which part of its resume key changed, and
 * the `stale-sleep` pass refreshes it first, in the background, so the player's own wake resumes.
 * What it leaves alone, how often, and a join that arrives while it refreshes. Against the fake
 * runtime with its sleeps switched on, as FLY_SUSPEND switches Fly's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { loadRevision } from '../servers/persistence.ts'
import { AGAIN_MS } from './schedules/stale-sleep.ts'
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

/** The steps the server's last start went through, in order. */
async function lastStart(id: string): Promise<{ steps: string[]; key: string }> {
  const [row] = await h.db
    .select({ steps: operations.steps, key: operations.idempotencyKey })
    .from(operations)
    .where(and(eq(operations.serverId, id), eq(operations.kind, 'start')))
    .orderBy(desc(operations.createdAt))
    .limit(1)
  return { steps: (row?.steps ?? []).map((entry) => entry.step), key: row?.key ?? '' }
}
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
    expect(refresh.key).toStartWith('start:refresh:')
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

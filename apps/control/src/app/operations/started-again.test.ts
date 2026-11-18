// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A sleep that finds its server's Java recording its start, which starts the server again in place
 * (`handlers/started-again.ts`) in place of a stop and a second boot. The start again itself is the
 * machine's (`start-cache-runtime.test.ts`, the image on the bench); here it is held open or settled
 * by the test, to see what the sleep around it does: the server says stopping throughout and a join
 * waits for it, its time stops counting where the sleep was asked, and one that doesn't come back is
 * the stop it used to be. Against the fake runtime with its sleeps switched on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { until } from '@blockly/contracts/waits'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import { DATA_DIR } from '../../minecraft/jars.ts'
import { CACHE_STATE } from '../../minecraft/start-cache.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'

/** The start again, as the test settles it: asked when the sleep calls, answered when the test says. */
let asked: { at: Date; answer: (up: boolean) => void } | null = null

const operations = schema.serverOperations
let h: Harness

beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness({
    startAgain: () =>
      new Promise<boolean>((answer) => {
        asked = { at: new Date(), answer }
      }),
  })
  h.runtime.sleeps.on = true
}, 30_000)

afterAll(async () => {
  await h?.close()
})

const running = async () => {
  const owner = await h.user(undefined, 'plus')
  const created = await h.create(owner)
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return { owner, id: created.id, slug: created.slug }
}
/** What the startup cache's script left on the server's volume: its Java records its start. */
const cacheIs = (id: string, phase: 'recording' | 'made') => {
  const state = join(h.runtime.machine(id)?.dir ?? '', CACHE_STATE.replace(`${DATA_DIR}/`, ''))
  mkdirSync(dirname(state), { recursive: true })
  writeFileSync(state, `made-for\n${phase}\n`)
}
/** Back up in place, its cache made from the run before, as the script leaves it. */
const cameBack = (id: string) => {
  cacheIs(id, 'made')
  asked?.answer(true)
}
/** The steps the server's last stop went through. */
async function stopSteps(id: string): Promise<string[]> {
  const [row] = await h.db
    .select({ steps: operations.steps })
    .from(operations)
    .where(and(eq(operations.serverId, id), eq(operations.kind, 'stop')))
    .orderBy(desc(operations.createdAt))
    .limit(1)
  return (row?.steps ?? []).map((entry) => entry.step)
}
/** A sleep nobody asked for, with the start again under way. */
const sleeping = async (owner: UserActor, id: string) => {
  asked = null
  cacheIs(id, 'recording')
  await h.app.servers.stop(owner, id, randomUUID(), 'idle')
  await until('the sleep to start its server again', () => asked !== null)
}

describe.skipIf(!hasDatabase)('a sleep that starts its recording server again in place', () => {
  test('says stopping throughout, a join waits for it, and the server sleeps on its memory after', async () => {
    const { owner, id, slug } = await running()
    await sleeping(owner, id)
    expect((await h.server(id)).lifecycle.status).toBe('stopping')
    expect(await h.app.edge.wake(`${slug}.play.test`)).toEqual({ outcome: 'starting', behind: 'stop' })

    cameBack(id)
    await h.until(id, 'stopped')
    await h.settled(id)
    expect(h.runtime.machine(id)?.state).toBe('suspended')
    expect(await stopSteps(id)).toEqual(expect.arrayContaining(['started_again', 'slept']))
    // Nothing follows it: the cache was made in place.
    await h.app.schedules.recordedStarts(new Date(), 50)
    expect(await stopSteps(id)).not.toContain('recording')
  }, 90_000)

  test('its time stops counting where the sleep was asked, not where the start again ends', async () => {
    const { owner, id } = await running()
    await sleeping(owner, id)
    const started = asked?.at ?? new Date()
    const [open] = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, id))
      .orderBy(desc(schema.powerIntervals.startedAt))
      .limit(1)
    expect(open?.stoppedAt).not.toBeNull()
    expect(open?.stoppedAt?.getTime() ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(started.getTime())
    cameBack(id)
    await h.until(id, 'stopped')
    await h.settled(id)
  }, 90_000)

  test('one that doesn’t come back is the stop it used to be, which a start nobody waits for follows', async () => {
    const { owner, id } = await running()
    await sleeping(owner, id)
    asked?.answer(false)
    await h.until(id, 'stopped')
    await h.settled(id)
    expect(h.runtime.machine(id)?.state).toBe('stopped')
    expect(await stopSteps(id)).toContain('recording')
    expect(await h.app.schedules.recordedStarts(new Date(), 50)).toBe(1)
    await h.until(id, 'running')
    await h.settled(id)
  }, 90_000)
})

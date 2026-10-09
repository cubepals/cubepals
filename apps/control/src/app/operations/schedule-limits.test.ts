import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { setMoveTo } from '../runtimes/persistence.ts'
import { loadRuntime } from '../servers/persistence.ts'
import { IDLE_GRACE_MS } from './schedules.ts'

const MINUTE = 60_000

// What one pass of a schedule does at most, and what an idle evaluation answers when it stops a
// server: a deploy that changes every spec, or a region remapped under many servers, is worked
// through a few at a time.
describe.skipIf(!hasDatabase)('drift, a few a pass', () => {
  const ring: { current: { version: number; key: string }; previous: { version: number; key: string }[] } = {
    current: { version: 1, key: 'limits-test-key-version-one' },
    previous: [],
  }
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ runtimeSecrets: ring })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a key rotation that drifts six running servers applies to five of them in one pass', async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const { id } = await h.create(await h.user(), { name: `Drifted ${i}` })
      ids.push(id)
    }
    for (const id of ids) {
      await h.until(id, 'running')
      await h.settled(id)
    }
    ring.previous = [ring.current]
    ring.current = { version: 2, key: 'limits-test-key-version-two' }
    expect(await h.app.schedules.drift()).toBe(5)
  }, 90_000)
})

describe.skipIf(!hasDatabase)('relocations, a few a pass', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ otherRuntimes: [{ provider: 'canary' }] })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('three moves a pass, the resting moves an operator asked for counted with the rest', async () => {
    const owner = await h.user('Resting')
    const resting = await h.create(owner, { name: 'Resting' })
    await h.until(resting.id, 'running')
    await h.settled(resting.id)
    await h.app.servers.stop(owner, resting.id, crypto.randomUUID())
    await h.until(resting.id, 'stopped')
    await h.settled(resting.id)
    // Resting in the archive store, as the store operation would leave it, with a move asked for.
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stored' })
      .where(eq(schema.minecraftServers.id, resting.id))
    await setMoveTo(h.db, resting.id, 'canary')

    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const { id } = await h.create(await h.user(), { name: `Remapped ${i}` })
      ids.push(id)
    }
    for (const id of ids) {
      await h.until(id, 'running')
      await h.settled(id)
    }
    h.runtime.remap('local', 'fake-2')
    try {
      expect(await h.app.schedules.relocations()).toBe(3)
      expect((await loadRuntime(h.db, resting.id, [...h.runtimes.keys()])).provider).toBe('fake')
      for (const id of ids) await h.settled(id, 20_000)
      // The fourth remapped server and the resting move, now that the pass has room for them.
      expect(await h.app.schedules.relocations()).toBe(2)
      expect((await loadRuntime(h.db, resting.id, [...h.runtimes.keys()])).provider).toBe('canary')
      for (const id of ids) await h.settled(id, 20_000)
    } finally {
      h.runtime.remap('local', 'fake-1')
    }
  }, 120_000)
})

describe.skipIf(!hasDatabase)('an idle evaluation that stops', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('a server nobody played on past its plan’s idle time is stopped, and the answer says so', async () => {
    const { id } = await h.create(await h.user())
    await h.until(id, 'running')
    await h.settled(id)
    await h.db
      .update(schema.powerIntervals)
      .set({ startedAt: sql`now() - interval '2 hours'` })
      .where(eq(schema.powerIntervals.serverId, id))
    await h.db.delete(schema.serverActivity).where(eq(schema.serverActivity.serverId, id))
    expect(
      await h.app.schedules.evaluateIdle(await h.server(id), new Date(Date.now() + IDLE_GRACE_MS + MINUTE)),
    ).toBe('stopped')
    expect((await h.until(id, 'stopped')).lifecycle.stopReason).toBe('idle')
  }, 30_000)
})

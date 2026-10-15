// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server put to sleep with its memory kept, where its runtime can (Fly's suspend), and woken as
 * it was: which stops sleep and which stop for real, what a wake skips and what it still does, the
 * races around both, and what a person sees when the provider refuses a suspend or drops what it
 * kept. Against the fake runtime with its sleeps switched on, as FLY_SUSPEND switches Fly's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { DAY_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, desc, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { MemoryStore } from '../../testing/memory-store.ts'
import type { UserActor } from '../actor.ts'
import { listBackups } from '../backups/persistence.ts'
import { loadRevision } from '../servers/persistence.ts'
import { lastWakeSeconds } from './persistence.ts'

const operations = schema.serverOperations

/** The steps the server's last operation of `kind` went through, in order. */
async function stepsOfLast(h: Harness, id: string, kind: 'start' | 'stop' = 'start'): Promise<string[]> {
  const [row] = await h.db
    .select({ steps: operations.steps })
    .from(operations)
    .where(and(eq(operations.serverId, id), eq(operations.kind, kind)))
    .orderBy(desc(operations.createdAt))
    .limit(1)
  return (row?.steps ?? []).map((entry) => entry.step).filter((step) => step !== 'attempt')
}

/** Whether the server's last start resumed it, as its steps say. */
const resumed = (steps: string[]) => steps.includes('resuming') && !steps.includes('booting')

// One harness for every describe but the last, which needs an archive store.
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

const running = async (plan?: string) => {
  const owner = await h.user(undefined, plan)
  const created = await h.create(owner)
  await h.until(created.id, 'running')
  await h.settled(created.id)
  return { owner, id: created.id, slug: created.slug }
}
const stop = async (owner: UserActor, id: string, reason: 'user' | 'idle' | 'maintenance' = 'user') => {
  await h.app.servers.stop(owner, id, randomUUID(), reason)
  await h.until(id, 'stopped')
  await h.settled(id)
}
const start = async (owner: UserActor, id: string) => {
  await h.app.servers.start(owner, id, randomUUID())
  await h.until(id, 'running')
  await h.settled(id)
  return stepsOfLast(h, id)
}
const settingsOf = async (id: string) =>
  (await loadRevision(h.db, (await h.server(id)).desiredRevisionId)).settings

describe.skipIf(!hasDatabase)('which stops put a server to sleep', () => {
  test('an idle stop and its owner’s stop put it to sleep, and a start wakes it as it was', async () => {
    const { owner, id } = await running()
    // Set in the game, not in its configuration: a boot would read the configuration again.
    await h.minecraft.inGame(id, 'difficulty hard')
    for (const reason of ['idle', 'user'] as const) {
      await stop(owner, id, reason)
      expect(h.runtime.machine(id)?.state).toBe('suspended')
      // Saved first, then written through to its disk, then asleep.
      expect(await stepsOfLast(h, id, 'stop')).toEqual(['saving', 'stopping'])
      expect((await h.server(id)).lifecycle).toMatchObject({ status: 'stopped', stopReason: reason })

      const steps = await start(owner, id)
      expect(resumed(steps)).toBe(true)
      expect(steps).toEqual(['resuming', 'access'])
      expect(h.minecraft.playing(id).difficulty).toBe('hard')
    }
    // Each wake is kept as a resume, apart from the boots before them.
    expect(await lastWakeSeconds(h.db, id, 'resumed')).not.toBeNull()
    expect(await lastWakeSeconds(h.db, id, 'booted')).toBeNull()
  }, 60_000)

  test('a stop for anything but sleep, a restart or a change stops it for real', async () => {
    const { owner, id } = await running()
    const sleeps = spyOn(h.runtime.sleeps, 'sleep')
    try {
      await stop(owner, id, 'maintenance')
      expect(h.runtime.machine(id)?.state).toBe('stopped')
      expect(await start(owner, id)).not.toContain('resuming')

      await h.app.servers.restart(owner, id, randomUUID())
      await h.until(id, 'running')
      await h.settled(id)
      await h.app.revisions.changeSettings(
        owner,
        id,
        { ...(await settingsOf(id)), difficulty: 'peaceful' },
        randomUUID(),
      )
      await h.until(id, 'running')
      await h.settled(id)
      expect(sleeps).not.toHaveBeenCalled()
    } finally {
      sleeps.mockRestore()
    }
  }, 60_000)

  test('with the runtime’s switch off, a sleep is a stop, as before', async () => {
    const { owner, id } = await running()
    h.runtime.sleeps.on = false
    await stop(owner, id, 'idle')
    expect(h.runtime.machine(id)?.state).toBe('stopped')
    expect(await start(owner, id)).toContain('booting')
  }, 30_000)

  test('a player on it when the idle stop comes is never frozen with it: it stops for real', async () => {
    const { owner, id } = await running()
    // Joined after the idle check read who was on, before the stop ran.
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Latecomer' })
    await stop(owner, id, 'idle')
    expect(h.runtime.machine(id)?.state).toBe('stopped')
  }, 30_000)
})

describe.skipIf(!hasDatabase)('a server going to sleep, or asleep, asked for more', () => {
  test('a join while it is going to sleep waits for the sleep, then wakes it at once', async () => {
    const { owner, id, slug } = await running()
    const release = h.runtime.sleeps.hold(1)
    try {
      await h.app.servers.stop(owner, id, randomUUID(), 'idle')
      await h.until(id, 'stopping')
      const joining = h.app.edge.wake(`${slug}.play.test`)
      await Bun.sleep(200)
      release()
      expect(await joining).toMatchObject({ outcome: 'ready' })
    } finally {
      release()
    }
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(resumed(await stepsOfLast(h, id))).toBe(true)
    // One stop, then one start: the join never started it twice.
    const kinds = (await h.operations(id)).map((op) => op.kind)
    expect(kinds.filter((kind) => kind === 'start')).toHaveLength(1)
  }, 30_000)

  test('a second stop or start asks nothing more of the runtime', async () => {
    const { owner, id } = await running()
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)
    expect((await h.operations(id)).filter((op) => op.kind === 'stop')).toHaveLength(1)
    expect(h.runtime.machine(id)?.state).toBe('suspended')

    await h.app.servers.start(owner, id, randomUUID())
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    expect((await h.operations(id)).filter((op) => op.kind === 'start')).toHaveLength(1)
    expect(resumed(await stepsOfLast(h, id))).toBe(true)
  }, 30_000)

  test('sent to the trash, then purged, while asleep: stopped for real, then gone', async () => {
    const { owner, id } = await running()
    await stop(owner, id)
    const created = await h.server(id)
    await h.app.servers.deleteServer(owner, id, created.name)
    await h.settled(id)
    expect(h.runtime.machine(id)).toMatchObject({ state: 'stopped', compute: false })
    await h.db
      .update(schema.minecraftServers)
      .set({ purgeAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.purgeSweep()
    await h.settled(id)
    expect(h.runtime.machine(id)).toBeNull()
  }, 30_000)
})

describe.skipIf(!hasDatabase)('what changed while a server slept', () => {
  test('who can join, changed while it slept, is put back as it wakes', async () => {
    const { owner, id } = await running()
    await h.app.access.setWhitelistEnabled(owner, id, true)
    await h.settled(id)
    await stop(owner, id)
    await h.app.access.add(owner, id, 'whitelist', 'Alex')
    await h.app.access.add(owner, id, 'operator', 'Steve')
    await h.settled(id)
    expect(resumed(await start(owner, id))).toBe(true)
    expect(await h.minecraft.login(id, 'Alex')).toBe('joined')
  }, 30_000)

  test('a change to its settings, Minecraft or mods while it slept boots that change', async () => {
    const { owner, id } = await running('plus')
    await stop(owner, id)
    await h.app.revisions.changeSettings(
      owner,
      id,
      { ...(await settingsOf(id)), difficulty: 'hard' },
      randomUUID(),
    )
    await h.settled(id)
    const steps = await start(owner, id)
    expect(steps).toContain('booting')
    expect(steps).not.toContain('resuming')
    expect(h.minecraft.playing(id).difficulty).toBe('hard')

    await stop(owner, id)
    await h.app.mods.changeVersion(owner, id, { gameVersion: '26.3', loader: 'fabric' }, [], randomUUID())
    await h.settled(id)
    expect(await start(owner, id)).toContain('booting')
    expect(h.runtime.machine(id)?.spec.env.TYPE).toBe('FABRIC')
  }, 60_000)

  test('a size change while it slept boots on the new size', async () => {
    const { owner, id } = await running('plus')
    await stop(owner, id)
    await h.app.revisions.resize(owner, id, '4g', randomUUID())
    await h.settled(id)
    const steps = await start(owner, id)
    expect(steps).toContain('booting')
    expect((await h.server(id)).memoryTier).toBe('4g')
  }, 60_000)
})

describe.skipIf(!hasDatabase)('a sleep or a wake that doesn’t go as planned', () => {
  test('a suspend the provider refuses is a stop: it sleeps all the same, and wakes from a boot', async () => {
    const { owner, id } = await running()
    h.runtime.sleeps.refused = true
    await stop(owner, id, 'idle')
    expect(h.runtime.machine(id)?.state).toBe('stopped')
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
    const steps = await start(owner, id)
    expect(steps).toContain('booting')
    expect(steps).not.toContain('resuming')
  }, 30_000)

  test('memory the provider dropped boots it instead, and the page counts down a boot', async () => {
    const { owner, id } = await running()
    await stop(owner, id, 'user')
    await start(owner, id)
    await stop(owner, id, 'user')
    // A host move while it slept: Fly boots it from its disk, as a real boot, in seconds.
    h.runtime.sleeps.drop(id)
    h.minecraft.bootTakes(11_000)
    await h.app.servers.start(owner, id, randomUUID())
    // A resume first, with the resume's countdown…
    await h.until(id, 'starting')
    let resuming = await h.app.queries.get(owner, id)
    while (resuming.activeOperation?.step == null) resuming = await h.app.queries.get(owner, id)
    expect(resuming.activeOperation?.step).toBe('resuming')
    expect(resuming.lastWakeSeconds).toBe(await lastWakeSeconds(h.db, id, 'resumed'))
    // …then, unanswered, a boot, with what this server's boots take.
    for (let at = Date.now(); Date.now() - at < 15_000; await Bun.sleep(100)) {
      const view = await h.app.queries.get(owner, id)
      if (view.activeOperation?.step !== 'resuming') {
        expect(view.lastWakeSeconds).toBe(await lastWakeSeconds(h.db, id, 'booted'))
        break
      }
    }
    await h.until(id, 'running', 20_000)
    await h.settled(id)
    expect(resumed(await stepsOfLast(h, id))).toBe(false)
  }, 60_000)

  test('a resume that never runs is given up on: a join waits, then plays the same world', async () => {
    const { owner, id, slug } = await running()
    // Played and saved before it slept: what a fresh start must find on its disk.
    await writeFile(h.minecraft.path(id, 'world/built.txt'), 'built before the sleep')
    await h.app.access.add(owner, id, 'operator', 'Steve')
    await h.settled(id)
    await stop(owner, id, 'idle')
    expect(h.runtime.machine(id)?.state).toBe('suspended')

    // A provider whose resume hangs, as a machine left starting: the join asks, and is told to wait.
    h.runtime.sleeps.hang(id)
    const asked = Date.now()
    const first = await h.app.edge.wake(`${slug}.play.test`)
    expect(['ready', 'starting']).toContain(first.outcome)
    await h.until(id, 'running', 20_000)
    await h.settled(id)
    // Given up on at the bound, then a boot: not a boot's whole wait first.
    expect(Date.now() - asked).toBeLessThan(15_000)
    expect(await h.app.edge.wake(`${slug}.play.test`)).toMatchObject({ outcome: 'ready' })

    const steps = await stepsOfLast(h, id)
    expect(steps.slice(0, 3)).toEqual(['resuming', 'resume_hung', 'booting'])
    expect(resumed(steps)).toBe(false)
    expect(h.runtime.machine(id)?.state).toBe('running')
    expect(await h.minecraft.file(id, 'world/built.txt')).toBe('built before the sleep')
    expect(await h.minecraft.login(id, 'Steve')).toBe('joined')

    // Counted where operators look, by server: the same one hanging again counts once.
    const admin = { kind: 'admin' as const, userId: (await h.user('Admin')).userId }
    const summary = async () =>
      (await h.app.alerts.active(admin)).find((a) => a.key === 'resumes_hung')?.summary ?? ''
    const counted = Number((await summary()).split(' ')[0])
    expect(counted).toBeGreaterThan(0)
    await stop(owner, id, 'idle')
    h.runtime.sleeps.hang(id)
    await start(owner, id)
    expect(await summary()).toStartWith(`${counted} server`)
  }, 60_000)

  test('a first resume counts down from what resumes take, not from a boot', async () => {
    const { owner, id } = await running()
    await stop(owner, id)
    const release = h.runtime.sleeps.hold(1)
    try {
      await h.app.servers.start(owner, id, randomUUID())
      for (let at = Date.now(); Date.now() - at < 5_000; await Bun.sleep(50)) {
        const view = await h.app.queries.get(owner, id)
        if (view.activeOperation?.step !== 'resuming') continue
        expect(view.lastWakeSeconds).toBe(2)
        break
      }
    } finally {
      release()
    }
    await h.until(id, 'running')
    await h.settled(id)
  }, 30_000)
})

describe.skipIf(!hasDatabase)('a wake that only another computer can serve', () => {
  // Each to the trash after, so the shared harness keeps room for the next.
  const made: { owner: UserActor; id: string }[] = []
  afterEach(async () => {
    for (const { owner, id } of made.splice(0)) {
      await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
      await h.settled(id)
    }
  })

  /** A player was on it just now, as the presence sweep records one. */
  const played = (id: string) =>
    h.db
      .insert(schema.serverActivity)
      .values({ serverId: id, lastPlayerAt: new Date() })
      .onConflictDoUpdate({ target: schema.serverActivity.serverId, set: { lastPlayerAt: new Date() } })

  /**
   * Asleep with something built in its world, played on, so the sleep took a snapshot of it as it
   * went to sleep; or, `played: false`, nobody on it, so the sleep took none.
   */
  const asleepWithSnapshot = async (options: { played?: boolean } = {}) => {
    const server = await running()
    made.push(server)
    await writeFile(h.minecraft.path(server.id, 'world/built.txt'), 'built before the sleep')
    if (options.played !== false) await played(server.id)
    await stop(server.owner, server.id, 'idle')
    await h.settled(server.id)
    expect(h.runtime.machine(server.id)?.state).toBe('suspended')
    return server
  }
  const sleepSnapshots = async (id: string) =>
    (await listBackups(h.db, id)).filter((b) => b.trigger === 'sleep' && b.status === 'ready')
  const kept = async (id: string) =>
    (
      await h.db
        .select({ kept: schema.serverRuntimes.keptStorage })
        .from(schema.serverRuntimes)
        .where(eq(schema.serverRuntimes.serverId, id))
    )[0]?.kept ?? null
  const kinds = async (id: string) => (await h.operations(id)).map((op) => op.kind)
  const admin = async () => ({ kind: 'admin' as const, userId: (await h.user('Admin')).userId })
  const alert = async (key: string) =>
    (await h.app.alerts.active(await admin())).find((a) => a.key === key)?.summary

  test('a resume that runs frozen, saying nothing, is started fresh from its disk', async () => {
    const { owner, id } = await asleepWithSnapshot()
    h.runtime.sleeps.freeze(id)
    const steps = await start(owner, id)
    expect(steps.slice(0, 3)).toEqual(['resuming', 'resume_hung', 'booting'])
    expect(await h.minecraft.file(id, 'world/built.txt')).toBe('built before the sleep')
    expect(await kinds(id)).not.toContain('relocate')
  }, 60_000)

  test('a machine wedged by a hung resume is rebuilt elsewhere from the snapshot, and plays', async () => {
    const { id, slug } = await asleepWithSnapshot()
    h.runtime.sleeps.hang(id, { wedged: true })
    const first = await h.app.edge.wake(`${slug}.play.test`)
    // Let in, or told to wait while it moves: never turned away.
    expect(['ready', 'starting']).toContain(first.outcome)
    await h.until(id, 'running', 30_000)
    await h.settled(id, 30_000)
    expect(await h.app.edge.wake(`${slug}.play.test`)).toMatchObject({ outcome: 'ready' })
    expect(await kinds(id)).toContain('relocate')
    expect(await h.minecraft.file(id, 'world/built.txt')).toBe('built before the sleep')
    expect(await alert('hosts_refused')).toContain('rebuilt elsewhere')
  }, 60_000)

  test('a host with no room left rebuilds it elsewhere from the sleep’s snapshot, keeping the old storage', async () => {
    const { owner, id } = await asleepWithSnapshot()
    expect(await sleepSnapshots(id)).toHaveLength(1)
    h.runtime.sleeps.fillHost(id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'relocating', 20_000)
    await h.until(id, 'running', 30_000)
    await h.settled(id, 30_000)
    expect(await h.minecraft.file(id, 'world/built.txt')).toBe('built before the sleep')
    // The old storage is kept, recorded for the leftovers sweep to keep, and admins see it.
    expect(await kept(id)).toHaveLength(1)
    expect(await alert('storage_kept')).toContain(id)
  }, 60_000)

  test('with no sleep’s snapshot, only an owner’s, its start fails for good, and a join tries again', async () => {
    const { owner, id, slug } = await asleepWithSnapshot({ played: false })
    // Taken by its owner: who knows what was played as it was taken. It is never a rebuild's.
    await h.app.backups.createBackup(owner, id, randomUUID())
    await h.settled(id)
    expect(await sleepSnapshots(id)).toHaveLength(0)
    h.runtime.sleeps.fillHost(id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'failed', 20_000)
    await h.settled(id)
    expect(await kinds(id)).not.toContain('relocate')
    expect(await h.minecraft.file(id, 'world/built.txt')).toBe('built before the sleep')
    expect(await alert('hosts_refused')).toBeDefined()
    // Failed for good, not back asleep: a waiting join hears so, rather than asking again forever.
    expect((await h.server(id)).lifecycle.failure?.during).toBe('starting')
    // The host has room again: a join tries the start once more, and wakes it where it is.
    expect(await h.app.edge.wake(`${slug}.play.test`)).toMatchObject({ outcome: 'ready' })
  }, 60_000)

  test('a sleep’s snapshot from before its last run is never a rebuild’s either', async () => {
    const { owner, id } = await asleepWithSnapshot()
    // Woken and asleep again with nobody on it: the run after the snapshot took none of its own.
    await start(owner, id)
    await stop(owner, id, 'idle')
    expect(await sleepSnapshots(id)).toHaveLength(1)
    h.runtime.sleeps.fillHost(id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'failed', 20_000)
    await h.settled(id)
    expect(await kinds(id)).not.toContain('relocate')
    expect(await kept(id)).toBeNull()
  }, 60_000)
})

describe.skipIf(!hasDatabase)('a server asleep with its memory kept, put to rest', () => {
  let h: Harness
  const store = new MemoryStore()

  beforeAll(async () => {
    await store.start()
    h = await startHarness({ capabilities: { archives: store, billing: null } })
    h.runtime.sleeps.on = true
  }, 30_000)

  afterAll(async () => {
    await h.close()
    store.close()
  })

  test('is stopped for real before its world is copied, and wakes from the copy by a boot', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    await h.app.servers.stop(owner, id, randomUUID(), 'idle')
    await h.until(id, 'stopped')
    await h.settled(id)
    expect(h.runtime.machine(id)?.state).toBe('suspended')

    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - 15 * DAY_MS) })
      .where(eq(schema.minecraftServers.id, id))
    const stops = spyOn(h.runtime, 'stop')
    const snapshots = spyOn(h.runtime, 'snapshot')
    try {
      await h.app.schedules.storeSweep()
      await h.settled(id, 20_000)
      expect((await h.server(id)).lifecycle.status).toBe('stored')
      // The real stop came first: the copy is of a disk nothing runs on.
      expect(stops).toHaveBeenCalled()
      expect(stops.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        snapshots.mock.invocationCallOrder[0] ?? -Infinity,
      )
    } finally {
      stops.mockRestore()
      snapshots.mockRestore()
    }
    expect(h.runtime.machine(id)).toMatchObject({ compute: false, released: true })

    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, (s) => s.lifecycle.status === 'running', 20_000)
    await h.settled(id, 20_000)
    expect((await h.operations(id)).at(-1)?.kind).toBe('unstore')
  }, 60_000)
})

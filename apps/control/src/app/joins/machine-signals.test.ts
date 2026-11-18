// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Signals about machines nobody saw (`machine-signals.ts`), on a real database and the fake
 * runtime: a Java killed for want of memory as it stopped, as it booted and while it ran, each raised
 * and emailed once, and none for a stop or crash that wasn't; and a server booted in the background
 * again and again with nobody joining it, and not one somebody joined.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import type { SignalsConfig } from '@blockly/contracts/join-records'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { Outbox } from '../../testing/outbox.ts'
import type { UserActor } from '../actor.ts'
import type { RuntimeHandle, RuntimeKey, RuntimeObservation } from '../ports/runtime.ts'
import { loadRuntime } from '../servers/persistence.ts'
import { READY_KEY } from '../servers/usage.ts'
import { installTuning, tuning } from '../tuning.ts'
import { tellSignals, type Written } from './signal-mail.ts'
import { raiseSignals } from './signals.ts'

let h: Harness
const deployed = tuning()
const outbox = new Outbox()
const tell = (config: SignalsConfig, written: Written[]) =>
  tellSignals(
    { db: h.db, mailer: outbox, inbox: ['ops@example.test'], origin: 'http://localhost:3000' },
    config.notify,
    written,
  )
const signalsOn = (signals: SignalsConfig) =>
  installTuning({ ...deployed, joins: { reporter: 'off', signals } })
const raised = (kind: string) => h.db.select().from(schema.signals).where(eq(schema.signals.kind, kind))
const power = (kind: 'start' | 'stop', owner: UserActor, id: string) =>
  h.app.servers[kind](owner, id, randomUUID())
const marks = async (id: string, kind: string) =>
  (
    await h.db
      .select({ kind: schema.serverOperations.kind, steps: schema.serverOperations.steps })
      .from(schema.serverOperations)
      .where(eq(schema.serverOperations.serverId, id))
  )
    .filter((op) => op.kind === kind)
    .flatMap((op) => (op.steps ?? []).map((entry) => entry.step))

/** The runtime says from now on, of every machine it is asked about, that its Java was just killed for want of memory. */
function sayKilled(): () => void {
  const { observe } = h.runtime
  h.runtime.observe = async (handle: RuntimeHandle) => ({
    ...(await observe.call(h.runtime, handle)),
    killedForMemoryAt: new Date(),
  })
  return () => {
    h.runtime.observe = observe
  }
}

/** A server of its own owner's, as a plan includes one, running; with who owns it. */
const running = async (name: string) => {
  const owner = await h.user()
  const { id } = await h.create(owner, { name })
  await h.until(id, 'running')
  return { owner, id }
}

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterEach(async () => {
  if (!hasDatabase) return
  installTuning(deployed)
  await h.db.delete(schema.signals)
  outbox.sent.length = 0
})

afterAll(async () => {
  await h?.close()
})

describe.skipIf(!hasDatabase)('a Java killed for want of memory', () => {
  test('a Java killed for want of memory as it stopped is raised and emailed once; a stop that went well, not', async () => {
    const { owner: theirs, id: clean } = await running('Stopped well')
    const { owner, id: killed } = await running('Killed stopping')
    await power('stop', theirs, clean)
    await h.until(clean, 'stopped')
    const restore = sayKilled()
    try {
      await power('stop', owner, killed)
      await h.until(killed, 'stopped')
    } finally {
      restore()
    }
    expect(await marks(clean, 'stop')).not.toContain('out_of_memory')
    expect(await marks(killed, 'stop')).toContain('out_of_memory')

    // Off in the setting, nothing is raised.
    signalsOn({ notify: ['out_of_memory'] })
    expect(await raiseSignals(h.db, new Date(), tell)).toBe(0)

    signalsOn({ outOfMemory: {}, notify: ['out_of_memory'] })
    expect(await raiseSignals(h.db, new Date(), tell)).toBe(1)
    const [signal] = await raised('out_of_memory')
    expect(signal).toMatchObject({
      serverId: killed,
      detail: { server: 'Killed stopping', during: 'stop', operationKind: 'stop', reason: 'user' },
    })
    expect(outbox.sent).toHaveLength(1)
    expect(JSON.stringify(outbox.sent[0])).toContain('killed as it stopped')
    // The next pass finds the same kill and raises nothing new.
    expect(await raiseSignals(h.db, new Date(), tell)).toBe(0)
    expect(outbox.sent).toHaveLength(1)
  }, 60_000)

  test('a Java killed for want of memory as it booted is marked on that boot and raised', async () => {
    const { owner, id } = await running('Killed booting')
    await power('stop', owner, id)
    await h.until(id, 'stopped')
    const restore = sayKilled()
    h.runtime.failBootWhen(() => 'Killed')
    try {
      await power('start', owner, id)
      await h.settled(id)
    } finally {
      h.runtime.failBootWhen(() => null)
      restore()
    }
    expect(await marks(id, 'start')).toContain('out_of_memory')
    signalsOn({ outOfMemory: {} })
    await raiseSignals(h.db, new Date())
    expect((await raised('out_of_memory')).map((s) => s.detail)).toContainEqual(
      expect.objectContaining({ server: 'Killed booting', during: 'boot', operationKind: 'start' }),
    )
  }, 60_000)

  test('a Java killed for want of memory while it ran is kept and raised; another crash is not', async () => {
    const { id: crashed } = await running('Crashed')
    const { id: killed } = await running('Killed running')
    h.runtime.crash(crashed, { code: 1, oom: false })
    h.runtime.crash(killed, { code: 137, oom: true })
    await h.app.schedules.reconcile()
    await h.until(crashed, 'stopped')
    await h.until(killed, 'stopped')
    signalsOn({ outOfMemory: {}, notify: ['out_of_memory'] })
    await raiseSignals(h.db, new Date(), tell)
    // Only these two servers: the kills the tests before left on their stops and boots are raised too.
    const theirs = (await raised('out_of_memory')).filter((s) => [crashed, killed].includes(s.serverId ?? ''))
    expect(theirs).toHaveLength(1)
    expect(theirs[0]).toMatchObject({
      serverId: killed,
      detail: { server: 'Killed running', during: 'play' },
    })
    expect(JSON.stringify(outbox.sent[0])).toContain('killed while it ran')
  }, 60_000)
})

describe.skipIf(!hasDatabase)('a kill the provider started the server again from', () => {
  /**
   * The provider lists the server running anew, at one time however often it is listed, and says,
   * asked, what its last exit was; the first `failing` times it is asked, it can't be reached.
   */
  async function relisted(id: string, said: Partial<RuntimeObservation>, failing = 0): Promise<() => void> {
    const handle = (await loadRuntime(h.db, id, ['fake'])).handle as RuntimeHandle
    const { observe, observeChanged } = h.runtime
    const listedAt = new Date()
    let failures = failing
    h.runtime.observeChanged = async function* (since) {
      for await (const listed of observeChanged.call(h.runtime, since)) if (listed.key !== id) yield listed
      yield { key: id as RuntimeKey, handle, observation: { state: 'running' as const, at: listedAt } }
    }
    h.runtime.observe = async (asked: RuntimeHandle) => {
      if (asked === handle && failures-- > 0) throw new Error('The provider can’t be reached')
      return { ...(await observe.call(h.runtime, asked)), ...(asked === handle ? said : {}) }
    }
    return () => {
      h.runtime.observe = observe
      h.runtime.observeChanged = observeChanged
    }
  }

  test('is kept once, however many passes see it, and after a pass that couldn’t ask; a stop’s kill a boot came after is not', async () => {
    const { id: restarted } = await running('Restarted by the provider')
    const { id: booted } = await running('Booted after its stop')
    const killedAt = new Date(Date.now() - 30_000)
    const restore = [
      // The first pass can't ask the provider: the next, listing the same, asks again.
      await relisted(restarted, { failedAt: killedAt, killedForMemoryAt: killedAt }, 1),
      await relisted(booted, { killedForMemoryAt: killedAt }),
    ]
    try {
      await h.app.schedules.reconcile()
      await h.app.schedules.reconcile()
      await h.app.schedules.reconcile()
    } finally {
      for (const undo of restore.reverse()) undo()
    }
    expect((await h.server(restarted)).lifecycle.status).toBe('running')
    signalsOn({ outOfMemory: {} })
    await raiseSignals(h.db, new Date())
    const theirs = (await raised('out_of_memory')).filter((s) =>
      [restarted, booted].includes(s.serverId ?? ''),
    )
    expect(theirs).toHaveLength(1)
    expect(theirs[0]).toMatchObject({
      serverId: restarted,
      detail: { server: 'Restarted by the provider', during: 'play', killedAt: killedAt.toISOString() },
    })
  }, 60_000)
})

describe.skipIf(!hasDatabase)('boots in the background', () => {
  test('a server booted in the background again and again with nobody joining is raised once a day', async () => {
    const { id: alone } = await running('Nobody came')
    const { id: played } = await running('Somebody came')
    const now = new Date()
    const start = async (serverId: string, steps: string[], key = `start:${READY_KEY}${randomUUID()}`) => {
      const at = new Date(now.getTime() - 2 * HOUR_MS)
      await h.db.insert(schema.serverOperations).values({
        id: randomUUID(),
        serverId,
        kind: 'start',
        status: 'succeeded',
        requestedBy: 'system:refresh',
        idempotencyKey: key,
        steps: steps.map((step) => ({ step, at: at.toISOString() })),
        createdAt: at,
        startedAt: at,
        finishedAt: new Date(at.getTime() + MINUTE_MS),
      })
    }
    for (const serverId of [alone, played]) {
      await start(serverId, ['attempt', 'booting'])
      await start(serverId, ['attempt', 'booting'])
    }
    // A resume costs no boot, and a player's wake is no background work: neither counts.
    await start(alone, ['attempt', 'resuming'])
    await start(alone, ['attempt', 'booting'], `start:${randomUUID()}`)
    await h.db.insert(schema.joins).values({
      id: randomUUID(),
      kind: 'join',
      serverId: played,
      address: 'somebody.play.test',
      connectedAt: new Date(now.getTime() - HOUR_MS),
      playerName: 'Alex',
    })

    signalsOn({ backgroundBoots: { perServerPerDay: 3 }, notify: ['background_boots'] })
    expect(await raiseSignals(h.db, now, tell)).toBe(0)
    await start(alone, ['attempt', 'booting'])
    await start(played, ['attempt', 'booting'])
    expect(await raiseSignals(h.db, now, tell)).toBe(1)
    const [signal] = await raised('background_boots')
    expect(signal).toMatchObject({ serverId: alone, detail: { server: 'Nobody came', figure: 3, limit: 3 } })
    expect(JSON.stringify(outbox.sent[0])).toContain('3 (limit 3)')
    await start(alone, ['attempt', 'booting'])
    expect(await raiseSignals(h.db, now, tell)).toBe(0)
  }, 60_000)
})

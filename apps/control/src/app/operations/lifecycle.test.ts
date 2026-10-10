import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { welcome } from '../../domain/revision/revision.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { DomainEvent } from '../ports/events.ts'
import { loadRuntime } from '../servers/persistence.ts'
import { loadOperation } from './persistence.ts'

// The whole control plane against the fake provider: services, the queue, workers, schedules.
describe.skipIf(!hasDatabase)('server lifecycle', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const power = (kind: 'start' | 'stop' | 'restart', owner: { kind: 'user'; userId: string }, id: string) =>
    h.app.servers[kind](owner, id, randomUUID())

  test('a new server provisions, boots, and holds the access record before it is running', async () => {
    const owner = await h.user()
    const created = await h.create(owner, { name: 'Sunset Valley' })
    expect(created.lifecycle.status).toBe('provisioning')
    const running = await h.until(created.id, 'running')

    const machine = h.runtime.machine(created.id)
    expect(machine?.state).toBe('running')
    expect(machine?.region).toBe('fake-1')
    const binding = await loadRuntime(h.db, created.id, ['fake'])
    expect(binding.handle).not.toBeNull()
    expect(binding.applied?.revisionId).toBe(running.desiredRevisionId)
    // The first boot re-imposes the record; the files now say what Blockly promised.
    const [access] = await h.db
      .select()
      .from(schema.serverAccess)
      .where(eq(schema.serverAccess.serverId, created.id))
    expect(access?.reseedRequired).toBe(false)
    expect(await h.minecraft.file(created.id, 'server.properties')).toContain('enforce-whitelist=true')
    const ops = await h.settled(created.id)
    expect(ops.map((op) => `${op.kind}:${op.status}`)).toContain('provision:succeeded')
  })

  test('stop, start and restart move the machine and the power intervals with them', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')

    await power('stop', owner, id)
    const stopped = await h.until(id, 'stopped')
    expect(stopped.lifecycle.stopReason).toBe('user')
    expect(h.runtime.machine(id)?.state).toBe('stopped')
    const closed = await h.db
      .select()
      .from(schema.powerIntervals)
      .where(eq(schema.powerIntervals.serverId, id))
    expect(closed.every((interval) => interval.stoppedAt !== null)).toBe(true)

    await power('start', owner, id)
    await h.until(id, 'running')
    expect(h.runtime.machine(id)?.state).toBe('running')

    await power('restart', owner, id)
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    const kinds = (await h.operations(id)).map((op) => `${op.kind}:${op.status}`)
    expect(kinds).toEqual(['provision:succeeded', 'stop:succeeded', 'start:succeeded', 'restart:succeeded'])
  })

  test('a restart is a stop, then a start the platform can still refuse (§10)', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const release = h.runtime.holdStops(1)
    try {
      await power('restart', owner, id)
      // The stop half first: saving, then the provider's stop, which hangs here.
      await h.until(id, 'stopping')
      // Starts are paused while it stops: the start half is refused, and the server stays off.
      await h.db.update(schema.platformControls).set({ startsEnabled: false })
      release()
      const stopped = await h.until(id, 'stopped')
      expect(stopped.lifecycle.stopReason).toBe('policy')
      expect(h.runtime.machine(id)?.state).toBe('stopped')
      const restart = (await h.settled(id)).find((o) => o.kind === 'restart')
      expect(restart).toMatchObject({ status: 'cancelled', error: expect.stringContaining('paused') })
      const intervals = await h.db
        .select()
        .from(schema.powerIntervals)
        .where(eq(schema.powerIntervals.serverId, id))
      expect(intervals.every((interval) => interval.stoppedAt instanceof Date)).toBe(true)
    } finally {
      release()
      await h.db.update(schema.platformControls).set({ startsEnabled: true })
    }
  }, 30_000)

  test('a crash the provider reports is noticed and recorded, and the server can start again', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    h.runtime.crash(id, { code: 137, oom: true })
    await h.app.schedules.reconcile()
    const crashed = await h.until(id, 'stopped')
    expect(crashed.lifecycle.stopReason).toBe('crash')
    const binding = await loadRuntime(h.db, id, ['fake'])
    expect(binding.observed?.state).toBe('crashed')
    expect(binding.observed?.detail).toBe('out of memory')
    // The owner sees why, which is what the page turns into a resize suggestion.
    expect((await h.app.queries.get(owner, id)).crash).toMatchObject({
      outOfMemory: true,
      detail: 'out of memory',
    })
    await power('start', owner, id)
    await h.until(id, 'running')
    expect((await h.app.queries.get(owner, id)).crash).toBeNull()
    // The crash it recorded is not news again: running again is.
    await h.app.schedules.reconcile()
    expect((await h.app.queries.get(owner, id)).status).toBe('running')
    expect((await loadRuntime(h.db, id, ['fake'])).observed?.state).toBe('running')
  })

  test('reconcile reads from where the last pass began, and again after one that did not settle', async () => {
    const sinces: number[] = []
    const listed = h.runtime.observeChanged.bind(h.runtime)
    h.runtime.observeChanged = (since) => {
      sinces.push(since.getTime())
      return listed(since)
    }
    try {
      const first = new Date()
      await h.app.schedules.reconcile(first)
      await h.app.schedules.reconcile(new Date(first.getTime() + 1_000))
      expect(sinces.at(-1)).toBe(first.getTime())
      // An hour on, everything is read again.
      await h.app.schedules.reconcile(new Date(first.getTime() + 61 * 60_000))
      expect(sinces.at(-1)).toBe(0)
      // A clock behind the last pass reads everything rather than from its future.
      await h.app.schedules.reconcile(new Date())
      expect(sinces.at(-1)).toBe(0)
      // A listing that fails part way leaves the window where it was.
      const settled = new Date()
      await h.app.schedules.reconcile(settled)
      h.runtime.observeChanged = async function* (since) {
        sinces.push(since.getTime())
        yield* listed(since)
        throw new Error('fake-2 could not be listed')
      }
      await expect(h.app.schedules.reconcile(new Date(settled.getTime() + 60_000))).rejects.toThrow('fake-2')
      h.runtime.observeChanged = (since) => {
        sinces.push(since.getTime())
        return listed(since)
      }
      await h.app.schedules.reconcile(new Date(settled.getTime() + 120_000))
      expect(sinces.at(-1)).toBe(settled.getTime())
    } finally {
      h.runtime.observeChanged = listed
      await h.app.schedules.reconcile()
    }
  })

  test('only a server’s current compute speaks for it: what a move replaced does not', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await power('stop', owner, id)
    await h.until(id, 'stopped')
    await h.app.servers.relocate(owner, id, 'far', randomUUID())
    await h.until(id, 'stopped')
    // The fake lists the replaced machine gone, after the one that replaced it.
    await h.app.schedules.reconcile()
    expect((await loadRuntime(h.db, id, ['fake'])).observed?.state).toBe('stopped')
  })

  test('compute running behind a stopped server is stopped, and the stop is audited', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await power('stop', owner, id)
    await h.until(id, 'stopped')
    // The stop records the server stopped before it records itself finished, and reconcile leaves
    // a server with an operation in flight for its next pass.
    await h.settled(id)
    const { handle } = await loadRuntime(h.db, id, ['fake'])
    if (handle === null) throw new Error('no handle')
    // Started at the provider, not through Blockly.
    await h.runtime.start(handle)
    expect(h.runtime.machine(id)?.state).toBe('running')
    await h.app.schedules.reconcile()
    expect(h.runtime.machine(id)?.state).toBe('stopped')
    expect((await h.app.queries.get(owner, id)).status).toBe('stopped')
    const audit = await h.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.stray_compute_stopped')),
      )
    expect(audit).toMatchObject([{ actor: 'system:reconcile', data: { status: 'stopped' } }])
    // It starts as usual afterwards.
    await power('start', owner, id)
    await h.until(id, 'running')
  })

  test('an admin stops a server for maintenance: audited, shown, and its owner can start it again', async () => {
    const owner = await h.user()
    const staff = await h.user()
    const admin = { kind: 'admin' as const, userId: staff.userId }
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    // Only an admin, and only with a reason.
    await expect(h.app.servers.stopForMaintenance(owner, id, randomUUID(), 'mine')).rejects.toThrow(
      'not found',
    )
    await expect(h.app.servers.stopForMaintenance(admin, id, randomUUID(), '  ')).rejects.toThrow('Say why')
    await h.app.servers.stopForMaintenance(admin, id, randomUUID(), 'Host upgrade in fake-1')
    const stopped = await h.until(id, 'stopped')
    expect(stopped.lifecycle.stopReason).toBe('maintenance')
    expect((await h.app.queries.get(owner, id)).stopReason).toBe('maintenance')
    expect(h.runtime.machine(id)?.state).toBe('stopped')
    const audited = () =>
      h.db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.maintenance_stop')))
    expect(await audited()).toMatchObject([
      { actor: `admin:${staff.userId}`, data: { reason: 'Host upgrade in fake-1' } },
    ])
    // A stopped server has nothing to stop, and nothing is recorded as done.
    await h.app.servers.stopForMaintenance(admin, id, randomUUID(), 'again')
    expect(await audited()).toHaveLength(1)
    await power('start', owner, id)
    await h.until(id, 'running')
  })

  test('closing a server already in the trash moves its purge up, bumps its version and says so', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Binned' })
    await h.until(id, 'running')
    await h.app.servers.deleteServer(owner, id, 'Binned')
    const deleted = await h.until(id, 'deleted')
    const heard: DomainEvent[] = []
    const unsubscribe = await h.events.subscribe((event) => heard.push(event))
    try {
      const closed = await h.app.servers.terminate({ kind: 'system', reason: 'policy' }, id)
      expect(closed.version).toBe(deleted.version + 1)
      expect(closed.purgeAfter?.getTime()).toBeLessThanOrEqual(Date.now())
      // The delete's own event may still be on its way; only what closing it said counts here.
      const said = () =>
        heard.filter((e) => e.type === 'server_changed' && e.serverId === id && e.version > deleted.version)
      for (let tries = 0; tries < 50 && said().length === 0; tries++) await Bun.sleep(100)
      expect(said()).toMatchObject([{ status: 'deleted', version: closed.version }])
      const audit = await h.db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'server.terminated')))
      expect(audit).toMatchObject([{ actor: 'system:policy' }])
    } finally {
      await unsubscribe()
    }
  })

  test('a start that fails for good stops the machine it left running', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Loads Forever' })
    await h.until(id, 'running')
    await power('stop', owner, id)
    await h.until(id, 'stopped')
    h.minecraft.stallOn((env) => env.MOTD === welcome('Loads Forever'))
    try {
      await power('start', owner, id)
      const failed = await h.until(id, 'failed', 40_000)
      expect(failed.lifecycle.failure?.during).toBe('starting')
      expect(h.runtime.machine(id)?.state).toBe('stopped')
    } finally {
      h.minecraft.stallOn(() => false)
    }
  }, 50_000)

  /** Every attempt the queue hands the runner from now, by operation, until `stop`. */
  const attemptsFrom = () => {
    const seen: string[] = []
    const run = h.app.runner.run
    h.app.runner.run = (attempt) => {
      seen.push(attempt.operationId)
      return run.call(h.app.runner, attempt)
    }
    return {
      of: (operationId: string | undefined) => seen.filter((id) => id === operationId).length,
      stop: () => {
        h.app.runner.run = run
      },
    }
  }

  // A pack's first start on staging (2026-09-27) answered nothing once its world began loading,
  // and each retry waited ten more minutes on the same process: half an hour, and no word.
  test('a first start that stops answering is started once more, fresh, and comes up then', async () => {
    const owner = await h.user()
    let hangs = 1
    h.minecraft.stallOn((env) => env.MOTD === welcome('Slow Riser') && hangs-- > 0)
    const attempts = attemptsFrom()
    try {
      const { id } = await h.create(owner, { name: 'Slow Riser' })
      await h.until(id, 'running', 20_000)
      const provision = (await h.settled(id)).find((op) => op.kind === 'provision')
      expect(provision?.status).toBe('succeeded')
      // Within its first attempt: nothing waited on the stuck process a second time.
      expect(attempts.of(provision?.id)).toBe(1)
    } finally {
      attempts.stop()
      h.minecraft.stallOn(() => false)
    }
  }, 30_000)

  test('a first start that hangs again fails for good in plain words, in one attempt', async () => {
    const owner = await h.user()
    h.minecraft.stallOn((env) => env.MOTD === welcome('Never Opens'))
    const attempts = attemptsFrom()
    try {
      const { id } = await h.create(owner, { name: 'Never Opens' })
      const failed = await h.until(id, 'failed', 30_000)
      expect(failed.lifecycle.failure?.during).toBe('provisioning')
      expect(failed.lifecycle.failure?.message).toEndWith('even on a second try.')
      expect(attempts.of(failed.lifecycle.failure?.operationId)).toBe(1)
      // Started, started once more, then stopped: a failed server holds no machine.
      const { handle } = await loadRuntime(h.db, id, ['fake'])
      if (handle === null) throw new Error('no handle')
      const printed = (await h.minecraft.recent(handle, 300)).map((line) => line.text)
      expect(printed.filter((text) => text.includes('Starting the Minecraft server'))).toHaveLength(2)
      expect(h.runtime.machine(id)?.state).toBe('stopped')
    } finally {
      attempts.stop()
      h.minecraft.stallOn(() => false)
    }
  }, 40_000)

  // Sent to the trash on staging (2026-09-27) while its first start hung, a server kept its
  // machine running for ten more minutes: the decommission waited behind the stuck attempt.
  test('a server sent to the trash while its first start hangs stops waiting, and its machine goes', async () => {
    const owner = await h.user()
    h.minecraft.stallOn((env) => env.MOTD === welcome('Changed My Mind'))
    const attempts = attemptsFrom()
    try {
      const { id } = await h.create(owner, { name: 'Changed My Mind' })
      // Its machine is up and its world never opens: the start is waiting on it.
      const deadline = Date.now() + 10_000
      while (h.runtime.machine(id)?.state !== 'running') {
        if (Date.now() > deadline) throw new Error('The machine never started')
        await Bun.sleep(20)
      }
      await h.app.servers.deleteServer(owner, id, 'Changed My Mind')
      await h.until(id, 'deleted')
      const operations = await h.settled(id)
      const provision = operations.find((op) => op.kind === 'provision')
      expect(provision).toMatchObject({
        status: 'cancelled',
        error: 'No longer applies: the server is deleted',
      })
      // Ended within the attempt that was waiting, not after it ran out and was tried again.
      expect(attempts.of(provision?.id)).toBe(1)
      expect(operations.find((op) => op.kind === 'decommission')?.status).toBe('succeeded')
      expect(h.runtime.machine(id)?.compute).toBe(false)
    } finally {
      attempts.stop()
      h.minecraft.stallOn(() => false)
    }
  }, 30_000)

  test('a server whose boot fails is failed, and a retry after the cause is fixed brings it up', async () => {
    const owner = await h.user()
    h.runtime.failBootWhen((spec) => (spec.env.MOTD === welcome('Doomed') ? 'bad world' : null))
    try {
      const { id } = await h.create(owner, { name: 'Doomed' })
      const failed = await h.until(id, 'failed', 30_000)
      expect(failed.lifecycle.failure?.during).toBe('provisioning')
      h.runtime.failBootWhen(() => null)
      await h.app.servers.retry(owner, id, randomUUID())
      await h.until(id, 'running')
    } finally {
      h.runtime.failBootWhen(() => null)
    }
  }, 40_000)

  test('a server whose first build failed gives way to the one its owner makes instead, address and all', async () => {
    // One server on the plan, and restoring the failed one needs room: a Plus account.
    const owner = await h.user('Replacing', 'plus')
    h.runtime.failBootWhen((spec) =>
      spec.env.MOTD === welcome('Wrong Pack') ? 'a mod needs a screen' : null,
    )
    try {
      const failed = await h.create(owner, { name: 'Wrong Pack' })
      await h.until(failed.id, 'failed', 30_000)
      // Only a server that never started can be replaced this way.
      const running = await h.create(owner, { name: 'Fine' })
      await h.until(running.id, 'running')
      const refused = await h.app.servers
        .createMinecraftServer(owner, {
          idempotencyKey: randomUUID(),
          name: 'Not This',
          partySize: '5',
          replaces: running.id,
        })
        .then(
          () => null,
          (error: { code?: string }) => error.code,
        )
      expect(refused).toBe('invalid_choice')

      const replacement = await h.app.servers.createMinecraftServer(owner, {
        idempotencyKey: randomUUID(),
        name: 'Right Pack',
        partySize: '5',
        replaces: failed.id,
      })
      // The new server has the old one's address; the old one is in the trash, where it can come back.
      expect(replacement.slug).toBe(failed.slug)
      expect((await h.server(failed.id)).deletedAt).not.toBeNull()
      await h.until(failed.id, 'deleted')
      await h.until(replacement.id, 'running')

      // Brought back, it can't have the address the new one holds: it gets one of its own.
      await h.app.servers.deleteServer(owner, running.id, 'Fine')
      const back = await h.app.servers.undeleteServer(owner, failed.id)
      expect(back.slug).not.toBe(failed.slug)
      expect((await h.server(replacement.id)).slug).toBe(failed.slug)
    } finally {
      h.runtime.failBootWhen(() => null)
    }
  }, 60_000)

  test('delete keeps storage and the address in quarantine; undelete and start bring it back', async () => {
    const owner = await h.user()
    const created = await h.create(owner, { name: 'Tidy Town' })
    await h.until(created.id, 'running')
    await h.app.servers.deleteServer(owner, created.id, 'Tidy Town')
    const deleted = await h.until(created.id, 'deleted')
    expect(deleted.purgeAfter).not.toBeNull()
    await h.settled(created.id)
    expect(h.runtime.machine(created.id)?.compute).toBe(false)
    const [retired] = await h.db
      .select()
      .from(schema.retiredSlugs)
      .where(eq(schema.retiredSlugs.slug, created.slug))
    expect(retired?.serverId).toBe(created.id)
    // Never listed: the usual 30 days.
    expect(
      Math.round(
        ((retired?.availableAfter.getTime() ?? 0) - (retired?.retiredAt.getTime() ?? 0)) / 86_400_000,
      ),
    ).toBe(30)
    expect(await h.app.queries.trash(owner)).toEqual([
      {
        id: created.id,
        name: 'Tidy Town',
        slug: created.slug,
        deletedAt: expect.any(String),
        purgeAfter: deleted.purgeAfter?.toISOString() ?? 'set',
        backups: { snapshots: expect.any(Number), archives: 0 },
      },
    ])

    await h.app.servers.undeleteServer(owner, created.id)
    await h.until(created.id, 'stopped')
    expect(await h.app.queries.trash(owner)).toEqual([])
    await power('start', owner, created.id)
    await h.until(created.id, 'running')
    expect(h.runtime.machine(created.id)?.compute).toBe(true)

    // Deleted a second time, it winds down a second time.
    await h.settled(created.id)
    await h.app.servers.deleteServer(owner, created.id, 'Tidy Town')
    await h.until(created.id, 'deleted')
    const operations = await h.settled(created.id)
    expect(operations.filter((o) => o.kind === 'decommission').map((o) => o.status)).toEqual([
      'succeeded',
      'succeeded',
    ])
    expect(h.runtime.machine(created.id)?.compute).toBe(false)
  })

  test('a stop that fails for good forces the server off, then fails it in stopping', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner, { name: 'Stuck On' })
    await h.until(id, 'running')
    await h.settled(id)
    h.runtime.failStops('the provider refused the stop')
    try {
      await power('stop', owner, id)
      const failed = await h.until(id, 'failed', 20_000)
      expect(failed.lifecycle.failure).toMatchObject({ during: 'stopping' })
      // Its owner reads whose side it was on; what the provider said stays with the operation.
      expect(failed.lifecycle.failure?.message).toBe(
        'This one was on Cubepals’ side, not yours. Trying again usually works.',
      )
      const operation = await loadOperation(h.db, failed.lifecycle.failure?.operationId ?? '')
      expect(operation?.detail).toContain('the provider refused the stop')
      expect(h.runtime.machine(id)?.state).toBe('stopped')
      const [interval] = await h.db
        .select()
        .from(schema.powerIntervals)
        .where(eq(schema.powerIntervals.serverId, id))
      expect(interval?.stoppedAt).toBeInstanceOf(Date)
    } finally {
      h.runtime.failStops(null)
    }
  }, 30_000)

  test('a decommission that keeps failing is tried again by the sweep until the compute is down', async () => {
    const owner = await h.user()
    const created = await h.create(owner, { name: 'Stubborn' })
    await h.until(created.id, 'running')
    await h.settled(created.id)
    h.runtime.failDecommissions('the machine is wedged')
    try {
      await h.app.servers.deleteServer(owner, created.id, 'Stubborn')
      const failed = await h.settled(created.id, 20_000)
      expect(failed.filter((o) => o.kind === 'decommission').map((o) => o.status)).toEqual(['failed'])
      expect(h.runtime.machine(created.id)?.compute).toBe(true)

      // Still failing: the sweep tries once for the failure it saw, and not again while it runs.
      await h.app.schedules.purgeSweep()
      await h.settled(created.id, 20_000)
      h.runtime.failDecommissions(null)
      await h.app.schedules.purgeSweep()
      const done = await h.settled(created.id, 20_000)
      expect(done.filter((o) => o.kind === 'decommission').map((o) => o.status)).toEqual([
        'failed',
        'failed',
        'succeeded',
      ])
      expect(h.runtime.machine(created.id)?.compute).toBe(false)
      // Converged: nothing more to try, and the purge waits for its date.
      await h.app.schedules.purgeSweep()
      expect((await h.settled(created.id)).filter((o) => o.kind === 'decommission')).toHaveLength(3)
      expect((await h.server(created.id)).lifecycle.status).toBe('deleted')
    } finally {
      h.runtime.failDecommissions(null)
    }
  }, 60_000)

  test('restoring from the trash is refused while the plan is full, and works once there is room', async () => {
    const owner = await h.user()
    const first = await h.create(owner, { name: 'First Home' })
    await h.until(first.id, 'running')
    await h.app.servers.deleteServer(owner, first.id, 'First Home')
    await h.until(first.id, 'deleted')
    await h.settled(first.id)
    // The free plan has room for one server, and the trash doesn't count.
    const second = await h.create(owner, { name: 'Second Home' })
    await h.until(second.id, 'running')
    await h.settled(second.id)
    const refused = await h.app.servers.undeleteServer(owner, first.id).then(
      () => null,
      (error: { code?: string }) => error.code,
    )
    expect(refused).toBe('limit_reached')
    expect((await h.server(first.id)).lifecycle.status).toBe('deleted')

    await h.app.servers.deleteServer(owner, second.id, 'Second Home')
    await h.until(second.id, 'deleted')
    await h.settled(second.id)
    await h.app.servers.undeleteServer(owner, first.id)
    await h.until(first.id, 'stopped')
    expect((await h.app.queries.trash(owner)).map((s) => s.name)).toEqual(['Second Home'])
  }, 40_000)

  test('a deleted server past its window is purged, and its provider resources with it', async () => {
    const owner = await h.user()
    const created = await h.create(owner, { name: 'Gone Soon' })
    await h.until(created.id, 'running')
    await h.app.servers.deleteServer(owner, created.id, 'Gone Soon')
    await h.until(created.id, 'deleted')
    await h.settled(created.id)
    await h.db
      .update(schema.minecraftServers)
      .set({ purgeAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.minecraftServers.id, created.id))
    await h.app.schedules.purgeSweep()
    await h.until(created.id, 'purged')
    await h.settled(created.id)
    expect(h.runtime.machine(created.id)).toBeNull()
  })

  test('compute no server here knows is stopped, kept and reported, and a purged server’s is destroyed', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    const spec = h.runtime.machine(id)?.spec ?? (null as never)
    const make = (key: string) =>
      h.runtime.ensureProvisioned(key as never, { regionKey: 'local' }, spec, {
        step: async () => {},
        handle: async () => {},
      })
    // As after the database is restored from a backup older than the server: its world stays.
    const unknown = randomUUID()
    await make(unknown)
    // A key that isn't a server id is kept too, and doesn't stop the sweep.
    await make('not-a-server-id')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await h.app.schedules.orphans()
      // Each time it is seen, by provider and key.
      const said = warn.mock.calls.map(([line]) => String(line))
      expect(said).toContainEqual(expect.stringContaining(`fake holds ${unknown}`))
      expect(said).toContainEqual(expect.stringContaining('fake holds not-a-server-id'))
    } finally {
      warn.mockRestore()
    }
    expect(h.runtime.machine(unknown)?.state).toBe('stopped')
    expect(h.runtime.machine('not-a-server-id')?.state).toBe('stopped')
    expect(h.runtime.machine(id)?.state).toBe('running')
    await h.runtime.destroy(unknown as never)
    await h.runtime.destroy('not-a-server-id' as never)

    // A purged server is gone for good: anything still held for it goes.
    await h.settled(id)
    await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
    await h.until(id, 'deleted')
    await h.settled(id)
    await h.db
      .update(schema.minecraftServers)
      .set({ purgeAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.purgeSweep()
    await h.until(id, 'purged')
    await h.settled(id)
    await make(id)
    expect(h.runtime.machine(id)).not.toBeNull()
    await h.app.schedules.orphans()
    expect(h.runtime.machine(id)).toBeNull()
  })

  test('a sweep that cannot read the database destroys nothing', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const db = h.db as { select: unknown }
    db.select = () => {
      throw new Error('Connection terminated unexpectedly')
    }
    try {
      await expect(h.app.schedules.orphans()).rejects.toThrow('Connection terminated')
    } finally {
      delete db.select
    }
    expect(h.runtime.machine(id)?.state).toBe('running')
  })

  test('a server another provider made is left alone: no route, and its operations refuse', async () => {
    const owner = await h.user()
    const created = await h.create(owner, { name: 'Elsewhere' })
    await h.until(created.id, 'running')
    await power('stop', owner, created.id)
    await h.until(created.id, 'stopped')
    // As when a local control plane points at a copy of staging data.
    await h.db
      .update(schema.serverRuntimes)
      .set({ provider: 'docker' })
      .where(eq(schema.serverRuntimes.serverId, created.id))
    const { routes } = await h.app.edge.routes()
    expect(routes.some((route) => route.hostname.startsWith(`${created.slug}.`))).toBe(false)
    await power('start', owner, created.id)
    const failed = await h.until(created.id, 'failed', 20_000)
    // The owner is told it can't be changed; which provider holds it is the platform's to read.
    expect(failed.lifecycle.failure?.message).toBe(
      'This server is hosted somewhere Cubepals no longer runs servers, so it can’t be changed.',
    )
    const operation = await loadOperation(h.db, failed.lifecycle.failure?.operationId ?? '')
    expect(operation?.detail).toContain('bound to the docker provider')
    expect(h.runtime.machine(created.id)?.state).toBe('stopped')
  })

  test('access changes reach a running server, and in-game changes are kept when it stops', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.app.access.setWhitelistEnabled(owner, id, true)
    await h.app.access.add(owner, id, 'whitelist', 'Alex')
    await h.settled(id)
    expect(await h.minecraft.file(id, 'server.properties')).toContain('white-list=true')
    expect(await h.minecraft.file(id, 'whitelist.json')).toContain('"name": "Alex"')

    // An operator in game ops Notch; Blockly hears of it when the server stops.
    await h.minecraft.inGame(id, 'op Notch')
    await power('stop', owner, id)
    await h.until(id, 'stopped')
    const view = await h.app.queries.access(owner, id)
    const notch = view.entries.find((entry) => entry.list === 'operator' && entry.player.name === 'Notch')
    expect(notch).toMatchObject({ state: 'active', origin: 'game' })
  })

  test('an IP ban made in game is lifted, audited, and explained to the owner (§15.1)', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    // An operator bans an address in game.
    await h.minecraft.inGame(id, 'ban-ip 203.0.113.7 spam')
    await h.app.access.refresh(owner, id)
    await h.settled(id)
    expect(await h.minecraft.file(id, 'banned-ips.json')).not.toContain('203.0.113.7')
    const [audit] = await h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, 'access.ip_ban_lifted')))
    expect(audit).toMatchObject({ actor: 'system:access', data: { ip: '203.0.113.7' } })
    expect((await h.app.queries.access(owner, id)).liftedIpBans).toEqual([
      { ip: '203.0.113.7', at: expect.any(String) },
    ])
  })

  test('opening the access page brings in what changed in game, once a minute at most', async () => {
    const owner = await h.user()
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await h.settled(id)
    const syncs = async () => (await h.operations(id)).filter((op) => op.kind === 'access_sync').length
    await h.minecraft.inGame(id, 'ban Spammer spam')
    const before = await syncs()
    const at = new Date()
    await h.app.access.refresh(owner, id, at)
    await h.settled(id)
    const view = await h.app.queries.access(owner, id)
    expect(view.entries.find((e) => e.list === 'ban')).toMatchObject({
      player: { name: 'Spammer' },
      state: 'active',
      origin: 'game',
    })
    // Opened again within the minute: nothing new is queued. A minute on, it syncs again.
    await h.app.access.refresh(owner, id, at)
    await h.settled(id)
    expect(await syncs()).toBe(before + 1)
    await h.app.access.refresh(owner, id, new Date(at.getTime() + 60_000))
    await h.settled(id)
    expect(await syncs()).toBe(before + 2)
    // Off, there is nothing to read: the next boot does it.
    await power('stop', owner, id)
    await h.until(id, 'stopped')
    const stopped = await syncs()
    await h.app.access.refresh(owner, id, new Date(at.getTime() + 120_000))
    expect(await syncs()).toBe(stopped)
  })
})

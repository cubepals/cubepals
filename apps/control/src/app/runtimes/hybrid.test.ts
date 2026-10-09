import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { schema } from '@blockly/db'
import { eq, inArray, sql } from 'drizzle-orm'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { createRuntimesApi, RUNTIMES_BASE } from '../../interfaces/operator/runtimes.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { type RuntimeHandle, runtimeKey } from '../ports/runtime.ts'
import { loadRuntime } from '../servers/persistence.ts'
import { recordPlay } from '../servers/usage.ts'

// One deployment, two runtimes (docs/runtimes.md): `fake` is the default, as Fly is in production,
// and `canary` stands in for the fleet. The archive store is a real S3 server, which moves between
// runtimes go through; the rest needs only Postgres.
const s3 = {
  endpoint: process.env.S3_TEST_ENDPOINT,
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
}
const OPERATOR = 'operator:test'
const DAY = 86_400_000

describe.skipIf(!hasDatabase)('several runtimes in one deployment', () => {
  let h: Harness
  const store =
    s3.endpoint && s3.bucket
      ? new S3ArchiveStore({
          endpoint: s3.endpoint,
          bucket: s3.bucket,
          region: 'auto',
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
        })
      : null

  beforeAll(async () => {
    h = await startHarness({
      capabilities: { archives: store, billing: null },
      runtimePrices: { runningHourCents: 6.25, storageMonthCents: 150 },
      otherRuntimes: [
        {
          provider: 'canary',
          prices: { runningHourCents: 0, storageMonthCents: 380 },
          capacity: {
            machines: [
              {
                name: 'node-1',
                region: 'eu',
                state: 'active',
                monthlyCents: 7600,
                allocatableMemoryMb: 61_440,
                allocatedMemoryMb: 6144,
                placedMemoryMb: 18_432,
                usedMemoryMb: 9000,
                cpus: 16,
                allocatedCpuMillis: 1500,
                usedCpuCores: 1.5,
                servers: 2,
              },
            ],
          },
        },
      ],
    })
  }, 30_000)

  afterEach(async () => {
    // Each test says where new servers go; none leaves a rule behind for the next.
    await h.db.update(schema.runtimeRules).set({ enabled: false })
    canary().fill('local', false)
    canary().fillOnProvision('local', false)
    canary().failRestores(null)
  })

  afterAll(async () => {
    if (store !== null) {
      const keys = await h.db
        .select({ key: schema.backups.archiveKey })
        .from(schema.backups)
        .where(sql`${schema.backups.archiveKey} is not null`)
      for (const { key } of keys) if (key) await store.delete(key)
    }
    await h.close()
  })

  const canary = () => {
    const found = h.runtimes.get('canary')
    if (found === undefined) throw new Error('no canary runtime')
    return found
  }
  const bound = (id: string) => loadRuntime(h.db, id, [...h.runtimes.keys()])
  const running = async (owner: UserActor) => {
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    return server.id
  }
  const stop = async (owner: UserActor, id: string) => {
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
  }
  const start = async (owner: UserActor, id: string) => {
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
  }

  test('a rule sends new servers to another runtime, and servers already made stay where they are', async () => {
    const owner = await h.user('Alex', 'plus')
    const before = await running(owner)
    expect((await bound(before)).provider).toBe('fake')
    const rule = await h.app.placement.addRule(
      { provider: 'canary', percent: 100, note: 'all new' },
      OPERATOR,
    )

    const after = await running(owner)
    expect((await bound(after)).provider).toBe('canary')
    expect(canary().machine(after)?.state).toBe('running')
    expect(h.runtime.machine(after)).toBeNull()

    // The older server keeps its runtime through stops and starts, whatever the rules say now.
    await stop(owner, before)
    await start(owner, before)
    expect((await bound(before)).provider).toBe('fake')
    expect(h.runtime.machine(before)?.state).toBe('running')
    expect(canary().machine(before)).toBeNull()

    // Where each server went, and why, is on record.
    const [placed] = (await h.app.placement.where(after)).decisions
    expect(placed).toMatchObject({
      kind: 'placed',
      provider: 'canary',
      ruleId: rule.id,
      decidedBy: `user:${owner.userId}`,
    })
    expect((await h.app.placement.where(before)).decisions[0]).toMatchObject({
      kind: 'placed',
      provider: 'fake',
      ruleId: null,
    })
  })

  test('an allowlisted account’s new servers go to the canary; nobody else’s do', async () => {
    const listed = await h.user('Listed', 'plus')
    const other = await h.user('Other', 'plus')
    const owners = await h.db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, listed.userId))
    await h.app.placement.addRule(
      { provider: 'canary', percent: 100, accounts: [owners[0]?.email ?? ''], plans: ['plus'] },
      OPERATOR,
    )
    expect((await bound(await running(listed))).provider).toBe('canary')
    expect((await bound(await running(other))).provider).toBe('fake')
    await expect(
      h.app.placement.addRule(
        { provider: 'canary', percent: 100, accounts: ['nobody@example.test'] },
        OPERATOR,
      ),
    ).rejects.toThrow(/no account for nobody@example.test/)
    await expect(h.app.placement.addRule({ provider: 'boat', percent: 5 }, OPERATOR)).rejects.toThrow(
      /not boat/,
    )
  })

  test('a canary with no room at placement places the server on the default, and says so', async () => {
    const owner = await h.user('Full', 'plus')
    await h.app.placement.addRule({ provider: 'canary', percent: 100 }, OPERATOR)
    canary().fill('local')
    const id = await running(owner)
    expect((await bound(id)).provider).toBe('fake')
    const [placed] = (await h.app.placement.where(id)).decisions
    expect(placed?.reason).toBe('the default runtime: canary had no room')
    expect(placed?.considered[0]).toMatchObject({ provider: 'canary', outcome: 'no_room' })
  })

  test('a canary that fills before a server’s first start sends it to the default, once, on record', async () => {
    const owner = await h.user('Raced', 'plus')
    await h.app.placement.addRule({ provider: 'canary', percent: 100 }, OPERATOR)
    canary().fillOnProvision('local')
    const id = await running(owner)
    expect((await bound(id)).provider).toBe('fake')
    expect(h.runtime.machine(id)?.state).toBe('running')
    const decisions = (await h.app.placement.where(id)).decisions
    expect(decisions.map((d) => d.kind)).toEqual(['fell_back', 'placed'])
    expect(decisions[0]).toMatchObject({
      provider: 'fake',
      fromProvider: 'canary',
      decidedBy: 'system:placement',
    })
    // Once started anywhere, a server never falls back again: a full runtime makes it wait.
    canary().fillOnProvision('local', false)
  })

  test('turning the canary off sends new servers to the default, and its servers keep working', async () => {
    const owner = await h.user('Kept', 'plus')
    const rule = await h.app.placement.addRule({ provider: 'canary', percent: 100 }, OPERATOR)
    const onCanary = await running(owner)
    await h.app.placement.changeRule(rule.id, { enabled: false }, OPERATOR)
    expect((await bound(await running(owner))).provider).toBe('fake')
    await stop(owner, onCanary)
    await start(owner, onCanary)
    expect((await bound(onCanary)).provider).toBe('canary')
    expect(canary().machine(onCanary)?.state).toBe('running')
  })

  test('compute a runtime holds for a server bound elsewhere is cleared by the orphan sweep', async () => {
    const owner = await h.user('Stray', 'plus')
    const id = await running(owner)
    const left = await canary().adopt(
      runtimeKey(id),
      { regionKey: 'local' },
      (await h.app.specs.desired(h.db, await h.server(id))).spec,
    )
    expect(canary().machine(id)).not.toBeNull()
    await h.app.schedules.orphans()
    expect(canary().machine(id)).toBeNull()
    expect(h.runtime.machine(id)?.state).toBe('running')
    expect(left).toBeDefined()
  })

  test('the economics report compares runtimes on what was recorded', async () => {
    const owner = await h.user('Payer', 'plus')
    const onDefault = await running(owner)
    await h.app.placement.addRule({ provider: 'canary', percent: 100 }, OPERATOR)
    const onCanary = await running(owner)
    const now = new Date()
    await recordPlay(h.db, onCanary, 'canary', 3, now)
    await recordPlay(h.db, onCanary, 'canary', 2, new Date(now.getTime() + 60_000))
    await h.db.insert(schema.billingOrders).values({
      provider: 'polar',
      externalOrderId: randomUUID(),
      userId: owner.userId,
      planKey: 'plus',
      billingReason: 'subscription_cycle',
      currency: 'usd',
      subtotalCents: 1500,
      discountCents: 0,
      netCents: 1500,
      taxCents: 0,
      totalCents: 1500,
      orderedAt: now,
    })
    const report = await h.app.economics.report({
      from: new Date(now.getTime() - DAY),
      to: new Date(now.getTime() + DAY),
    })
    const byProvider = new Map(report.runtimes.map((row) => [row.provider, row]))
    const fake = byProvider.get('fake')
    const machines = byProvider.get('canary')
    expect(fake?.usageCents).toBeGreaterThan(0)
    expect(fake?.capacityCents).toBe(0)
    expect(machines?.capacityCents).toBeGreaterThan(0)
    expect(machines?.idleCents).toBeGreaterThan(0)
    // Its machines' memory-hours, against those its servers ran: tiny, for a server that ran minutes.
    expect(machines?.runningUtilization).toBeGreaterThanOrEqual(0)
    expect(machines?.runningUtilization).toBeLessThan(0.05)
    expect(fake?.runningUtilization).toBeNull()
    expect(machines?.playerHours).toBeGreaterThan(0)
    expect(report.machines[0]).toMatchObject({ provider: 'canary', utilization: 0.1, strandedMemoryMb: 0 })
    const servers = new Map(report.servers.map((s) => [s.serverId, s]))
    const paid = (servers.get(onDefault)?.revenueCents ?? 0) + (servers.get(onCanary)?.revenueCents ?? 0)
    expect(paid).toBeCloseTo(1500, 0)
    expect(servers.get(onCanary)?.feeCents).toBeGreaterThan(0)
    expect(report.assumptions.bandwidth).toMatch(/not measured/)
  })

  test('operators steer placement over the internal API, with the operator token', async () => {
    const api = createRuntimesApi({
      placement: h.app.placement,
      economics: h.app.economics,
      token: 'x'.repeat(32),
    })
    const call = (path: string, init: RequestInit = {}, token = 'x'.repeat(32)) =>
      api.request(`${RUNTIMES_BASE}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'x-operator': 'tester',
          'content-type': 'application/json',
        },
      })
    expect((await call('/rules', {}, 'y'.repeat(32))).status).toBe(401)
    const made = await call('/rules', {
      method: 'POST',
      body: JSON.stringify({ provider: 'canary', percent: 5 }),
    })
    expect(made.status).toBe(201)
    const { rule } = (await made.json()) as { rule: { id: string; createdBy: string; percent: number } }
    expect(rule).toMatchObject({ createdBy: 'operator:tester', percent: 5 })
    const refused = await call('/rules', {
      method: 'POST',
      body: JSON.stringify({ provider: 'canary', percent: 101 }),
    })
    expect(refused.status).toBe(400)
    const changed = await call(`/rules/${rule.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    })
    expect(((await changed.json()) as { rule: { enabled: boolean } }).rule.enabled).toBe(false)
    const summary = (await (await call('/summary')).json()) as {
      defaultProvider: string
      providers: unknown[]
    }
    expect(summary.defaultProvider).toBe('fake')
    expect((await call('/economics')).status).toBe(200)
    expect((await call(`/servers/${randomUUID()}`)).status).toBe(404)
  })

  describe.skipIf(store === null)('moves between runtimes', () => {
    /** A stopped server with a file only its world holds. */
    const built = async (name: string) => {
      const owner = await h.user(name, 'plus')
      const id = await running(owner)
      await writeFile(h.minecraft.path(id, 'world/built.txt'), `${name}'s castle`)
      await stop(owner, id)
      return { owner, id }
    }
    const castle = (id: string) => readFile(h.minecraft.path(id, 'world/built.txt'), 'utf8')

    test('nothing moves until an operator asks, and then it moves through the archive store', async () => {
      const { owner, id } = await built('Mover')
      const from = (await bound(id)).handle as RuntimeHandle
      await h.app.placement.addRule({ provider: 'canary', percent: 100 }, OPERATOR)
      expect(await h.app.schedules.relocations()).toBe(0)
      expect((await bound(id)).provider).toBe('fake')

      await h.app.placement.requestMove(id, 'canary', OPERATOR)
      expect((await bound(id)).moveTo).toBe('canary')
      expect(await h.app.schedules.relocations()).toBeGreaterThan(0)
      await h.settled(id, 20_000)
      const moved = await bound(id)
      expect(moved).toMatchObject({ provider: 'canary', moveTo: null })
      expect((await h.server(id)).lifecycle.status).toBe('stopped')
      // What it had where it was is gone; its world is where it is now.
      expect(h.runtime.machine(id)).toBeNull()
      expect(h.runtime.owns(from)).toBe(true)
      await start(owner, id)
      expect(canary().machine(id)?.state).toBe('running')
      expect(await castle(id)).toBe("Mover's castle")
      const kinds = (await h.app.placement.where(id)).decisions.map((d) => d.kind)
      expect(kinds.slice(0, 2)).toEqual(['moved', 'move_requested'])

      // And back again, the same way.
      await stop(owner, id)
      await h.app.placement.requestMove(id, 'fake', OPERATOR)
      await h.app.schedules.relocations()
      await h.settled(id, 20_000)
      expect((await bound(id)).provider).toBe('fake')
      await start(owner, id)
      expect(await castle(id)).toBe("Mover's castle")
      expect(canary().machine(id)).toBeNull()
    }, 60_000)

    test('a move that fails leaves the server where it was, with its world', async () => {
      const { owner, id } = await built('Stayer')
      canary().failRestores('the disk filled')
      await h.app.placement.requestMove(id, 'canary', OPERATOR)
      await h.app.schedules.relocations()
      await h.settled(id, 20_000)
      expect(await bound(id)).toMatchObject({ provider: 'fake', moveTo: null })
      expect((await h.server(id)).lifecycle.status).toBe('stopped')
      expect((await h.app.placement.where(id)).decisions[0]).toMatchObject({
        kind: 'move_failed',
        provider: 'fake',
      })
      expect(canary().machine(id)).toBeNull()
      await start(owner, id)
      expect(await castle(id)).toBe("Stayer's castle")
    }, 60_000)

    test('a move that fails where there is no room to run it again leaves it asleep where it was', async () => {
      const owner = await h.user('Squeezed', 'plus')
      const id = await running(owner)
      await writeFile(h.minecraft.path(id, 'world/built.txt'), "Squeezed's castle")
      canary().failRestores('the disk filled')
      // Its own runtime filled while the move was tried: nothing stopped starts there for now.
      h.runtime.full('the host filled up')
      try {
        await h.app.placement.requestMove(id, 'canary', OPERATOR)
        await h.app.schedules.relocations()
        await h.settled(id, 20_000)
      } finally {
        h.runtime.full(null)
      }
      expect((await h.server(id)).lifecycle).toMatchObject({ status: 'stopped', failure: null })
      expect(await bound(id)).toMatchObject({ provider: 'fake', moveTo: null })
      expect(canary().machine(id)).toBeNull()
      await start(owner, id)
      expect(await castle(id)).toBe("Squeezed's castle")
    }, 60_000)

    test('a resting server moves by its binding alone, and wakes on the other runtime', async () => {
      const { owner, id } = await built('Sleeper')
      await h.db
        .update(schema.minecraftServers)
        .set({ lastActiveAt: new Date(Date.now() - 60 * DAY) })
        .where(eq(schema.minecraftServers.id, id))
      await h.app.schedules.storeSweep()
      await h.settled(id, 20_000)
      expect((await h.server(id)).lifecycle.status).toBe('stored')

      await h.app.placement.requestMove(id, 'canary', OPERATOR)
      expect(await h.app.schedules.relocations()).toBe(1)
      const moved = await bound(id)
      expect(moved.provider).toBe('canary')
      expect(canary().owns(moved.handle as RuntimeHandle)).toBe(true)
      expect((await h.server(id)).lifecycle.status).toBe('stored')
      expect(h.runtime.machine(id)).toBeNull()

      await start(owner, id)
      expect(canary().machine(id)?.state).toBe('running')
      expect(await castle(id)).toBe("Sleeper's castle")
    }, 60_000)
  })
})

describe.skipIf(!hasDatabase)('a default runtime at its provider’s limit', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness({ serverCeiling: 1, otherRuntimes: [{ provider: 'canary' }] })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('new servers overflow to a runtime with room, on record, rather than wait for one', async () => {
    const owner = await h.user('Many', 'plus')
    const first = await h.create(owner)
    await h.until(first.id, 'running')
    const second = await h.create(owner)
    await h.until(second.id, 'running')
    const providers = [...h.runtimes.keys()]
    expect((await loadRuntime(h.db, first.id, providers)).provider).toBe('fake')
    expect((await loadRuntime(h.db, second.id, providers)).provider).toBe('canary')
    expect((await h.app.placement.where(second.id)).decisions[0]?.reason).toBe(
      "overflow: fake is at its provider's limit",
    )
  })

  test('a server the full default overflowed has no fallback: it waits for room where it went', async () => {
    const owner = await h.user('Overflowed', 'plus')
    const canary = h.runtimes.get('canary')
    if (canary === undefined) throw new Error('no canary runtime')
    const providers = [...h.runtimes.keys()]
    // Room went between its placement and its first start.
    canary.fillOnProvision('local')
    try {
      const { id } = await h.create(owner)
      await h.until(id, 'failed', 30_000)
      expect((await loadRuntime(h.db, id, providers)).provider).toBe('canary')
      const decisions = (await h.app.placement.where(id)).decisions
      expect(decisions.map((d) => [d.kind, d.reason])).toEqual([
        ['placed', "overflow: fake is at its provider's limit"],
      ])
      // Nothing was made on the default, which is at its provider's limit.
      expect(h.runtime.machine(id)).toBeNull()

      canary.fillOnProvision('local', false)
      await h.app.servers.retry(owner, id, randomUUID())
      await h.until(id, 'running', 20_000)
      expect(canary.machine(id)?.state).toBe('running')
    } finally {
      canary.fillOnProvision('local', false)
    }
  }, 60_000)

  test('a resting world holds no machine, so it leaves its provider room for another', async () => {
    const owner = await h.user('Rested', 'plus')
    const onDefault = await h.db
      .select({ id: schema.serverRuntimes.serverId })
      .from(schema.serverRuntimes)
      .where(eq(schema.serverRuntimes.provider, 'fake'))
    expect(onDefault.length).toBeGreaterThan(0)
    // Nobody played on them for a while: their worlds rest in the store, and their machines are gone.
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stored' })
      .where(
        inArray(
          schema.minecraftServers.id,
          onDefault.map((server) => server.id),
        ),
      )
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    expect((await loadRuntime(h.db, id, [...h.runtimes.keys()])).provider).toBe('fake')
    expect((await h.app.placement.where(id)).decisions[0]?.reason).toBe('the default runtime')
  })
})

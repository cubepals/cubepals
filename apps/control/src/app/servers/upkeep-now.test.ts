/**
 * What an operator does to accounts and servers through the operators' API, against the whole
 * control plane on the fake provider: a server made for someone, rested now, and purged now, each
 * recorded as the operator's; and, where there is an object store, a world played minutes ago
 * rested all the way into it and woken whole. The rest of resting is `operations/storing.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import { S3ArchiveStore } from '../../infra/s3/s3-archive-store.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { OperatorActor } from '../actor.ts'

describe.skipIf(!hasDatabase)('an operator acting on servers', () => {
  let h: Harness
  const ada: OperatorActor = { kind: 'operator', name: 'ada' }

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(() => h?.close())

  const auditOf = (serverId: string, action: string) =>
    h.db
      .select({ actor: schema.auditLog.actor })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, serverId), eq(schema.auditLog.action, action)))

  test('a server made for an account is its owner’s, held to their plan, and the operator’s doing', async () => {
    const owner = await h.user('Ada')
    const made = await h.app.servers.createFor(ada, owner.userId, {
      idempotencyKey: randomUUID(),
      name: 'Made For You',
      partySize: '5',
    })
    expect(made.ownerId).toBe(owner.userId)
    expect(await auditOf(made.id, 'server.created')).toEqual([{ actor: 'operator:ada' }])
    const [provision] = await h.operations(made.id)
    expect(provision?.requestedBy).toBe('operator:ada')
    await h.until(made.id, 'running')
    // A Free account holds one server: an operator gets no more than its owner would.
    await expect(
      h.app.servers.createFor(ada, owner.userId, {
        idempotencyKey: randomUUID(),
        name: 'Another',
        partySize: '5',
      }),
    ).rejects.toThrow()
  }, 30_000)

  test('resting now is the store operation, asked for a stopped server however recently it was played', async () => {
    const owner = await h.user('Rested')
    const { id } = await h.create(owner)
    await h.until(id, 'running')
    await expect(h.app.servers.upkeep.rest(ada, id, randomUUID())).rejects.toThrow('Stop it first')
    await h.app.servers.stop(ada, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    // Owners never rest a world themselves: Blockly does it.
    await expect(h.app.servers.upkeep.rest(owner, id, randomUUID())).rejects.toThrow('not found')
    await h.app.servers.upkeep.rest(ada, id, randomUUID())
    const store = (await h.operations(id)).find((op) => op.kind === 'store')
    expect(store).toMatchObject({ requestedBy: 'operator:ada', input: { now: true } })
    expect(await auditOf(id, 'server.rest_requested')).toEqual([{ actor: 'operator:ada' }])
    // This deployment keeps no archives, so the store itself lets go of nothing.
    await h.settled(id)
    expect((await h.server(id)).lifecycle.status).toBe('stopped')
  }, 30_000)

  test('purging now takes a server out of the trash for good, by its exact name, without waiting', async () => {
    const owner = await h.user('Purged')
    const { id } = await h.create(owner, { name: 'Short Lived' })
    await h.until(id, 'running')
    await expect(h.app.servers.upkeep.purge(ada, id, 'Short Lived')).rejects.toThrow('Send it there first')
    await h.app.servers.deleteServer(ada, id, 'Short Lived')
    await h.until(id, 'deleted')
    await h.settled(id)
    await expect(h.app.servers.upkeep.purge(ada, id, 'Short')).rejects.toThrow('exactly')
    await expect(h.app.servers.upkeep.purge(owner, id, 'Short Lived')).rejects.toThrow('not found')
    await h.app.servers.upkeep.purge(ada, id, 'Short Lived')
    await h.until(id, 'purged')
    expect(h.runtime.machine(id)).toBeNull()
    const purge = (await h.operations(id)).find((op) => op.kind === 'purge')
    expect(purge?.requestedBy).toBe('operator:ada')
    expect(await auditOf(id, 'server.purge_requested')).toEqual([{ actor: 'operator:ada' }])
    expect(await auditOf(id, 'server.deleted')).toEqual([{ actor: 'operator:ada' }])
    // Out of the trash for good: there is nothing left to take back.
    await expect(h.app.servers.undeleteServer(ada, id)).rejects.toThrow()
  }, 30_000)

  test('an operator sets an account’s plan and limits, recorded as theirs', async () => {
    const owner = await h.user('Comped')
    await h.app.accounts.setPlan(ada, owner.userId, 'plus')
    await h.app.accounts.setLimits(ada, owner.userId, { maxServers: 3, maxRunning: 2 })
    const account = await h.app.accountQueries.get(ada, owner.userId)
    expect(account.standing.plan).toBe('plus')
    expect(account.standing.limitOverrides).toMatchObject({ maxServers: 3, maxRunning: 2 })
    expect(account.history.map((entry) => [entry.action, entry.actor])).toEqual([
      ['account.limits_set', 'operator:ada'],
      ['account.plan_set', 'operator:ada'],
    ])
  })
})

describe.skipIf(!hasDatabase || !process.env.S3_TEST_ENDPOINT || !process.env.S3_TEST_BUCKET)(
  'an operator resting a world now',
  () => {
    let h: Harness
    const store = new S3ArchiveStore({
      endpoint: process.env.S3_TEST_ENDPOINT ?? '',
      bucket: process.env.S3_TEST_BUCKET ?? '',
      region: 'auto',
      accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'blockly-test',
      secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'blockly-test-secret',
    })

    beforeAll(async () => {
      h = await startHarness({ capabilities: { archives: store, billing: null } })
    }, 30_000)
    afterAll(async () => {
      const keys = await h.db
        .select({ key: schema.backups.archiveKey })
        .from(schema.backups)
        .where(sql`${schema.backups.archiveKey} is not null`)
      for (const { key } of keys) if (key) await store.delete(key)
      await h.close()
    })

    test('a world played minutes ago rests, lets go of its machine and disk, and comes back whole', async () => {
      const owner = await h.user('Olive')
      const { id } = await h.create(owner)
      await h.until(id, 'running')
      await h.settled(id)
      await writeFile(h.minecraft.path(id, 'world/built.txt'), "Olive's castle")
      await h.app.servers.stop(owner, id, randomUUID())
      await h.until(id, 'stopped')
      await h.settled(id)
      // The sweep leaves it: nobody has been away long enough.
      await h.app.schedules.storeSweep()
      await h.settled(id)
      expect((await h.server(id)).lifecycle.status).toBe('stopped')

      await h.app.servers.upkeep.rest({ kind: 'operator', name: 'production-check' }, id, randomUUID())
      await h.settled(id, 20_000)
      expect((await h.server(id)).lifecycle.status).toBe('stored')
      expect(h.runtime.machine(id)).toMatchObject({ compute: false, released: true })

      await h.app.servers.start(owner, id, randomUUID())
      await h.until(id, 'running', 20_000)
      expect(await readFile(h.minecraft.path(id, 'world/built.txt'), 'utf8')).toBe("Olive's castle")
    }, 60_000)
  },
)

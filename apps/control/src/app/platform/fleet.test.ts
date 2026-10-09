import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

// An operator finding their way around the provider (docs/operator-view.md): each server's owner, name
// and plan written where the provider lists it, and the admin list that says where each one is
// and what it costs there.
describe.skipIf(!hasDatabase)('the servers, as an operator finds them', () => {
  let h: Harness
  let admin: Extract<Actor, { kind: 'admin' }>

  beforeAll(async () => {
    h = await startHarness({ runtimePrices: { runningHourCents: 10, storageMonthCents: 300 } })
    const person = await h.user('Admin')
    await h.db.insert(schema.platformAdmins).values({ userId: person.userId, grantedBy: 'test' })
    admin = { kind: 'admin', userId: person.userId }
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const stopped = async (name: string, plan = 'free') => {
    const owner = await h.user('Alex', plan)
    const server = await h.create(owner, { name })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(owner, server.id, randomUUID())
    await h.until(server.id, 'stopped')
    await h.settled(server.id)
    return { owner, server }
  }

  test('each server’s owner, name and plan reach the provider, and again only when they change', async () => {
    const { owner, server } = await stopped('Weekend world', 'plus')
    await h.app.fleet.tag()
    expect(h.runtime.tagsOf(server.id)).toEqual({
      owner: `${owner.userId}@example.test`,
      name: 'Weekend world',
      plan: 'plus',
    })
    expect(await h.app.fleet.tag()).toBe(0)
    await h.db
      .update(schema.minecraftServers)
      .set({ name: 'Monday world' })
      .where(eq(schema.minecraftServers.id, server.id))
    expect(await h.app.fleet.tag()).toBe(1)
    expect(h.runtime.tagsOf(server.id)?.name).toBe('Monday world')
  }, 60_000)

  test('admins find a server by its name, its owner, its id or the provider’s name for it', async () => {
    const { owner, server } = await stopped('Cherry grove')
    const found = async (search: string) =>
      (await h.app.fleet.list(admin, { search, offset: 0, limit: 50 })).servers.map((s) => s.id)
    expect(await found('cherry')).toEqual([server.id])
    expect(await found(`${owner.userId}@example.test`)).toEqual([server.id])
    expect(await found(server.id)).toEqual([server.id])
    expect(await found(`bly-prod-${server.id.replace(/-/g, '')}`)).toEqual([server.id])
    const [row] = (await h.app.fleet.list(admin, { search: server.id, offset: 0, limit: 50 })).servers
    expect(row).toMatchObject({
      name: 'Cherry grove',
      status: 'stopped',
      size: '3 GB',
      owner: { userId: owner.userId, email: `${owner.userId}@example.test`, plan: 'free' },
      provider: { link: null },
    })
    expect(row?.provider?.names[0]?.label).toBe('Machine')
    await expect(h.app.fleet.list(owner, { search: '', offset: 0, limit: 50 })).rejects.toThrow()
  }, 60_000)

  test('this month’s cost is its hours at the size they ran, and its storage so far', async () => {
    const { server } = await stopped('Priced')
    const now = new Date('2030-01-15T12:00:00Z')
    await h.db.insert(schema.powerIntervals).values([
      // Two hours this month, one of them before it began, and one that hasn't happened yet.
      {
        serverId: server.id,
        memoryTier: '3g',
        startedAt: new Date('2030-01-10T10:00:00Z'),
        stoppedAt: new Date('2030-01-10T12:00:00Z'),
      },
      {
        serverId: server.id,
        memoryTier: '3g',
        startedAt: new Date('2029-12-31T23:00:00Z'),
        stoppedAt: new Date('2030-01-01T01:00:00Z'),
      },
      {
        serverId: server.id,
        memoryTier: '3g',
        startedAt: new Date('2030-01-20T10:00:00Z'),
        stoppedAt: new Date('2030-01-20T11:00:00Z'),
      },
    ])
    const [row] = (await h.app.fleet.list(admin, { search: server.id, offset: 0, limit: 50 }, now)).servers
    // 3 h at 10¢, and 14.5 of January's 31 days of 300¢ storage.
    expect(row?.month).toEqual({ hours: 3, costCents: Math.round(30 + (300 * 14.5) / 31) })
    // A resting world holds no storage there.
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stored' })
      .where(eq(schema.minecraftServers.id, server.id))
    const [resting] = (await h.app.fleet.list(admin, { search: server.id, offset: 0, limit: 50 }, now))
      .servers
    expect(resting?.month.costCents).toBe(30)
  }, 60_000)
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

const HOUR = 3_600_000
const players = schema.serverPlayers

// Who has played on a server: remembered wherever presence is written — the server's own reading
// and the edge's hints — kept through leaving and stops, and offered on the Players page with
// whoever is on now first. Purging the server forgets them.
describe.skipIf(!hasDatabase)('who has played', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id, slug: created.slug }
  }
  const history = (serverId: string) =>
    h.db.select().from(players).where(eq(players.serverId, serverId)).orderBy(asc(players.playerName))
  /** Moves both times a player was seen back by `hours`, as if it had all been that long ago. */
  const seenAgo = (serverId: string, uuid: string, hours: number) =>
    h.db
      .update(players)
      .set({
        firstSeenAt: sql`${players.firstSeenAt} - make_interval(hours => ${hours})`,
        lastSeenAt: sql`${players.lastSeenAt} - make_interval(hours => ${hours})`,
      })
      .where(and(eq(players.serverId, serverId), eq(players.playerUuid, uuid)))

  test('whoever the server reads as online is remembered, and stays remembered after leaving', async () => {
    const { owner, id } = await running()
    const alex = { uuid: randomUUID(), name: 'Alex' }
    h.minecraft.join(id, alex)
    await h.app.schedules.presenceSync()
    const [first] = await history(id)
    expect(first).toMatchObject({ playerUuid: alex.uuid, playerName: 'Alex' })
    expect(first?.firstSeenAt).toEqual(first?.lastSeenAt)
    // The server's page lists them with the UUID their face is found by.
    expect((await h.app.queries.get(owner, id)).players).toEqual({ online: 1, people: [alex] })

    // Gone from the server, still someone who played there.
    h.minecraft.leave(id, alex.uuid)
    await h.app.schedules.presenceSync()
    expect(
      await h.db.select().from(schema.serverPresence).where(eq(schema.serverPresence.serverId, id)),
    ).toEqual([])
    expect(await history(id)).toHaveLength(1)

    // Back a day later: when they were first seen stays, when they were last seen moves up.
    await seenAgo(id, alex.uuid, 24)
    h.minecraft.join(id, alex)
    await h.app.schedules.presenceSync()
    const [again] = await history(id)
    expect(again?.firstSeenAt.getTime()).toBe((first?.firstSeenAt.getTime() ?? 0) - 24 * HOUR)
    expect(Date.now() - (again?.lastSeenAt.getTime() ?? 0)).toBeLessThan(HOUR)
  }, 30_000)

  test('the edge’s connects are remembered too, and the server’s own reading renames a player', async () => {
    const { id, slug } = await running()
    const uuid = randomUUID()
    const session = (name: string, at: Date) =>
      h.app.edge.recordSession({
        edgeId: 'e1',
        hostname: `${slug}.play.test`,
        event: 'connect',
        player: { name, uuid },
        at: at.toISOString(),
      })
    await session('Alex', new Date())
    expect(await history(id)).toMatchObject([{ playerUuid: uuid, playerName: 'Alex' }])

    // They renamed themselves: the server reads the same player under the new name.
    await seenAgo(id, uuid, 1)
    h.minecraft.join(id, { uuid, name: 'Alexandra' })
    await h.app.schedules.presenceSync()
    const renamed = await history(id)
    expect(renamed).toMatchObject([{ playerUuid: uuid, playerName: 'Alexandra' }])

    // A hint from before the rename that arrives late moves neither the name nor the times.
    await session('Alex', new Date(Date.now() - HOUR / 2))
    expect(await history(id)).toEqual(renamed)

    // A game can claim any name at the door: a fresh claim moves when they were last seen, but
    // only the server itself renames a player it knows.
    await session('Imposter', new Date())
    const claimed = await history(id)
    expect(claimed).toMatchObject([{ playerUuid: uuid, playerName: 'Alexandra' }])
    expect(claimed[0]?.lastSeenAt.getTime()).toBeGreaterThan(renamed[0]?.lastSeenAt.getTime() ?? 0)
  }, 30_000)

  test('the Players page offers who has played there: whoever is on first, then the most recent', async () => {
    const { owner, id } = await running()
    const steve = { uuid: randomUUID(), name: 'Steve' }
    const alex = { uuid: randomUUID(), name: 'Alex' }
    const notch = { uuid: randomUUID(), name: 'Notch' }
    for (const player of [steve, alex, notch]) h.minecraft.join(id, player)
    await h.app.schedules.presenceSync()
    for (const player of [steve, alex]) h.minecraft.leave(id, player.uuid)
    await h.app.schedules.presenceSync()
    await seenAgo(id, steve.uuid, 48)
    await seenAgo(id, alex.uuid, 2)
    // The same name under a second UUID, as after the server stopped checking accounts: offered once.
    await h.db.insert(players).values({
      serverId: id,
      playerUuid: randomUUID(),
      playerName: 'Notch',
      firstSeenAt: new Date(Date.now() - 72 * HOUR),
      lastSeenAt: new Date(Date.now() - 72 * HOUR),
    })

    expect((await h.app.queries.access(owner, id)).players).toEqual([
      { name: 'Notch', uuid: notch.uuid, online: true },
      { name: 'Alex', uuid: alex.uuid, online: false },
      { name: 'Steve', uuid: steve.uuid, online: false },
    ])
    // Another server's players are its own.
    const other = await running()
    expect((await h.app.queries.access(other.owner, other.id)).players).toEqual([])

    // Stopped, nobody is on, and everybody is still known.
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    expect((await h.app.queries.access(owner, id)).players).toEqual([
      { name: 'Notch', uuid: notch.uuid, online: false },
      { name: 'Alex', uuid: alex.uuid, online: false },
      { name: 'Steve', uuid: steve.uuid, online: false },
    ])
  }, 40_000)

  test('a server in the trash still knows its players; purged, it forgets them', async () => {
    const { owner, id } = await running()
    h.minecraft.join(id, { uuid: randomUUID(), name: 'Alex' })
    await h.app.schedules.presenceSync()
    await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
    await h.until(id, 'deleted')
    await h.settled(id)
    expect(await history(id)).toHaveLength(1)

    await h.db
      .update(schema.minecraftServers)
      .set({ purgeAfter: sql`now() - interval '1 hour'` })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.purgeSweep()
    await h.until(id, 'purged', 20_000)
    await h.settled(id)
    expect(await history(id)).toEqual([])
  }, 40_000)
})

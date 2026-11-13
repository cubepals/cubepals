// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server's own player list as a witness of its joins, through the presence pass itself: a
 * player on the list marks their join as seen there and one who isn't doesn't; a list that can't
 * be read marks nothing; the reporter's own time is never the list's; of two joins of one player
 * the one handed over last is theirs; a mark made after a join had ended is taken back; a Bedrock
 * player is found under Floodgate's name. And what the marks mean to their readers (`reached.ts`):
 * which joins are listed as stopped short, on a server with a reporter and on one without; that a
 * join the list showed in the world is never read as refused; and that a server which once
 * reported and runs without its reporter now is read as one with none.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { floodgateName, floodgateUuid } from '@blockly/contracts'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { ServerJoinEvent, VisitReport } from '@blockly/contracts/join-records'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { noteListed } from './player-list.ts'

const joins = schema.joins

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  h?.minecraft.refuseCommands(null)
  await h?.close()
})

/** A made-up player, named for the test it is in. */
const player = (name: string) => ({ name, uuid: randomUUID() })
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/** A running server, and the address its joins come through. */
const running = async (name: string) => {
  const made = await h.create(await h.user(name), { name })
  await h.until(made.id, 'running')
  await h.settled(made.id)
  return { id: made.id, address: `${(await h.server(made.id)).slug}.play.test` }
}
type Server = Awaited<ReturnType<typeof running>>

/** A join the edge handed to `to` `handedMsAgo` ago, still open; its id. */
const handed = async (
  to: Server,
  who: { name: string; uuid?: string },
  handedMsAgo: number,
  fields: Partial<VisitReport> = {},
) => {
  const joinId = randomUUID()
  await h.app.joins.recordVisits([
    {
      joinId,
      phase: 'open',
      edgeId: 'edge-1',
      region: 'fra',
      address: to.address,
      source: `203.0.113.${1 + Math.floor(Math.random() * 250)}:${40_000 + Math.floor(Math.random() * 20_000)}`,
      connectedAt: ago(handedMsAgo + 50),
      player: who,
      path: 'direct',
      handedAt: ago(handedMsAgo),
      ...fields,
    },
  ])
  return joinId
}

/** The edge's word that join `id` ended `leftMsAgo` ago. */
const closed = async (to: Server, id: string, leftMsAgo: number) => {
  const [row] = await h.db.select().from(joins).where(eq(joins.id, id))
  if (row?.edgeId == null) throw new Error(`no join ${id}`)
  await h.app.joins.recordVisits([
    {
      joinId: id,
      phase: 'close',
      edgeId: row.edgeId,
      region: 'fra',
      address: to.address,
      source: row.source ?? '203.0.113.1:40000',
      connectedAt: row.connectedAt.toISOString(),
      leftAt: ago(leftMsAgo),
    },
  ])
}

const row = async (id: string) => {
  const [found] = await h.db.select().from(joins).where(eq(joins.id, id))
  if (found === undefined) throw new Error(`no join ${id}`)
  return found
}

/** A sample of a server's ticks as its reporter posts one, taken at `at`. */
const sampleAt = (at: string) => ({
  at,
  tps: 20,
  mspt: 10,
  msptP95: 15,
  msptMax: 30,
  players: 1,
  chunks: 400,
  entities: 90,
  heapUsedMb: 900,
  heapMaxMb: 2048,
  gcMs: 4,
})

/** The pass as the scheduler runs it: every running server's list read once. */
const pass = () => h.app.schedules.presenceSync()

/** The ids the operators' list gives as stopped short on `to`. */
const stoppedShort = async (to: Server) =>
  (await h.app.joins.list({ server: to.id, stoppedShort: true, limit: 500 })).map((join) => join.id)

describe.skipIf(!hasDatabase)('a server’s player list, read by the presence pass', () => {
  test('marks the join of a player on it, and says nothing of one handed over moments ago who isn’t', async () => {
    const to = await running('Listed')
    const kai = player('Kai')
    const noor = player('Noor')
    const on = await handed(to, kai, 5 * SECOND_MS)
    const off = await handed(to, noor, 5 * SECOND_MS)
    h.minecraft.join(to.id, kai)
    const before = Date.now()
    await pass()

    const seen = await row(on)
    expect(seen.serverSide).toBe('console')
    const listedAt = Date.parse(String(seen.detail.listedAt))
    expect(listedAt).toBeGreaterThanOrEqual(before)
    expect(listedAt).toBeLessThanOrEqual(Date.now())
    // The list's moment is its own: no column the reporter writes, or a join is timed by, holds it.
    expect(seen).toMatchObject({ loginAt: null, inWorldAt: null, configuredAt: null, tick: null })

    expect(await row(off)).toMatchObject({ serverSide: 'not_reported', detail: {} })

    const [view] = await h.app.joins.list({ server: to.id, player: kai.name })
    expect(view).toMatchObject({ serverSide: 'console', inWorldAt: null, notListedAt: null })
    expect(view?.listedAt).toBe(String(seen.detail.listedAt))
    // A second reading leaves the first moment standing.
    await pass()
    expect((await row(on)).detail.listedAt).toBe(seen.detail.listedAt)
  }, 30_000)

  test('marks a join still open a pass after it was handed over, its player not on the list, as not there', async () => {
    const to = await running('Missing')
    const late = await handed(to, player('Sunny'), 90 * SECOND_MS)
    const nameless = await handed(to, { name: '' }, 90 * SECOND_MS, { player: undefined })
    await pass()
    const missed = await row(late)
    expect(missed.serverSide).toBe('not_reported')
    expect(missed.detail.listedAt).toBeUndefined()
    expect(Date.parse(String(missed.detail.notListedAt))).toBeLessThanOrEqual(Date.now())
    // Nobody to look for on a join that never named its player.
    expect((await row(nameless)).detail).toEqual({})

    // In the world at last, a reading later: seen, with the earlier reading kept beside it.
    const sunny = { name: missed.playerName ?? '', uuid: missed.playerUuid ?? '' }
    h.minecraft.join(to.id, sunny)
    await pass()
    const now = await row(late)
    expect(now.serverSide).toBe('console')
    expect(now.detail.notListedAt).toBe(missed.detail.notListedAt)
    expect(typeof now.detail.listedAt).toBe('string')
    expect(await stoppedShort(to)).not.toContain(late)
  }, 30_000)

  test('marks nothing when the list can’t be read', async () => {
    const to = await running('Unread')
    const efe = player('Efe')
    const on = await handed(to, efe, 5 * SECOND_MS)
    const off = await handed(to, player('Noor'), 90 * SECOND_MS)
    h.minecraft.join(to.id, efe)
    h.minecraft.refuseCommands(/^list/)
    try {
      await pass()
    } finally {
      h.minecraft.refuseCommands(null)
    }
    // Unknown, not absent: neither the player on it nor the one long handed over is marked.
    expect(await row(on)).toMatchObject({ serverSide: 'not_reported', detail: {} })
    expect(await row(off)).toMatchObject({ serverSide: 'not_reported', detail: {} })
    await pass()
    expect((await row(on)).serverSide).toBe('console')
    expect(typeof (await row(off)).detail.notListedAt).toBe('string')
  }, 30_000)

  test('never writes the reporter’s time, and stands beside it when both spoke', async () => {
    const to = await running('Both')
    const event = (kind: ServerJoinEvent['kind'], who: { name: string; uuid: string }, at: string) =>
      ({ kind, at, uuid: who.uuid, name: who.name }) satisfies ServerJoinEvent

    // The reporter first: the list has nothing to add to a join already in the world.
    const kai = player('Kai')
    const told = await handed(to, kai, 20 * SECOND_MS)
    const exact = ago(18 * SECOND_MS)
    await h.app.joins.recordServerEvents(to.id, [
      event('login', kai, ago(19 * SECOND_MS)),
      event('in_world', kai, exact),
    ])
    h.minecraft.join(to.id, kai)
    await pass()
    const first = await row(told)
    expect(first.serverSide).toBe('reported')
    expect(first.inWorldAt?.toISOString()).toBe(exact)
    expect(first.detail.listedAt).toBeUndefined()

    // The list first, then the reporter: its own time is written as it told it, and the row is
    // the reporter's from then on. The list's moment is kept as what it is, another witness's.
    const noor = player('Noor')
    const seen = await handed(to, noor, 20 * SECOND_MS)
    h.minecraft.join(to.id, noor)
    await pass()
    const listedAt = (await row(seen)).detail.listedAt
    expect(await row(seen)).toMatchObject({ serverSide: 'console', inWorldAt: null })
    const later = ago(17 * SECOND_MS)
    await h.app.joins.recordServerEvents(to.id, [event('in_world', noor, later)])
    const both = await row(seen)
    expect(both.serverSide).toBe('reported')
    expect(both.inWorldAt?.toISOString()).toBe(later)
    expect(both.detail.listedAt).toBe(listedAt)
    await pass()
    expect((await row(seen)).inWorldAt?.toISOString()).toBe(later)
  }, 30_000)
})

describe.skipIf(!hasDatabase)('whose join a reading of the list is about', () => {
  test('of two joins of one player, marks the one handed over last', async () => {
    const to = await running('Retry')
    const kai = player('Kai')
    // A try that failed, whose end the edge hasn't told of yet, and the retry seconds after it.
    const failed = await handed(to, kai, 20 * SECOND_MS)
    const retry = await handed(to, kai, 10 * SECOND_MS)
    h.minecraft.join(to.id, kai)
    await pass()
    expect(await row(retry)).toMatchObject({ serverSide: 'console' })
    expect(await row(failed)).toMatchObject({ serverSide: 'not_reported', detail: {} })
    // A minute on, the first is still open on its row, and its player is on the list: not absent.
    await h.db
      .update(joins)
      .set({ handedAt: new Date(Date.now() - 90 * SECOND_MS) })
      .where(eq(joins.id, failed))
    await pass()
    expect((await row(failed)).detail).toEqual({})
    // The edge's word of its end: it left before any reading, so nobody knows how far it got.
    await closed(to, failed, 18 * SECOND_MS)
    expect(await row(failed)).toMatchObject({ serverSide: 'not_reported', detail: {} })
    expect(await stoppedShort(to)).toEqual([])
  }, 30_000)

  test('takes back a mark made after the join had ended', async () => {
    const to = await running('Settled')
    // Handed over 90 s ago and, unknown to the pass, gone 80 s ago: the edge tells of an end late.
    const gone = await handed(to, player('Efe'), 90 * SECOND_MS)
    await pass()
    expect(typeof (await row(gone)).detail.notListedAt).toBe('string')
    await closed(to, gone, 80 * SECOND_MS)
    expect((await row(gone)).detail.notListedAt).toBeUndefined()
    expect(await stoppedShort(to)).not.toContain(gone)

    // Seen on the list, but the join had ended before the reading: the player was on another.
    const kai = player('Kai')
    const earlier = await handed(to, kai, 30 * SECOND_MS)
    h.minecraft.join(to.id, kai)
    await pass()
    expect((await row(earlier)).serverSide).toBe('console')
    await closed(to, earlier, 25 * SECOND_MS)
    const after = await row(earlier)
    expect(after.serverSide).toBe('not_reported')
    expect(after.detail.listedAt).toBeUndefined()

    // A mark made while the join was open stands once it ends.
    const sunny = player('Sunny')
    const stayed = await handed(to, sunny, 30 * SECOND_MS)
    h.minecraft.join(to.id, sunny)
    await pass()
    h.minecraft.leave(to.id, sunny.uuid)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await closed(to, stayed, 0)
    expect(await row(stayed)).toMatchObject({ serverSide: 'console' })
    expect(typeof (await row(stayed)).detail.listedAt).toBe('string')
  }, 30_000)

  test('calls no join absent on a list that counts a player it couldn’t name', async () => {
    const to = await running('Unnamed')
    const waiting = await handed(to, player('Efe'), 90 * SECOND_MS)
    await noteListed(h.db, to.id, { online: 1, players: [] }, new Date())
    expect((await row(waiting)).detail).toEqual({})
    await noteListed(h.db, to.id, { online: 0, players: [] }, new Date())
    expect(typeof (await row(waiting)).detail.notListedAt).toBe('string')
  }, 30_000)

  test('says nothing of a join handed over after the list was read', async () => {
    const to = await running('Came back')
    const noor = player('Noor')
    // On the list as it was read half a minute ago, for a visit that began before it; the retry
    // was handed over since, and is the later of the two rows still open.
    const before = await handed(to, noor, 90 * SECOND_MS)
    const retry = await handed(to, noor, 5 * SECOND_MS)
    const readAt = new Date(Date.now() - 30 * SECOND_MS)
    await noteListed(h.db, to.id, { online: 1, players: [noor] }, readAt)
    expect((await row(retry)).detail).toEqual({})
    expect((await row(retry)).serverSide).toBe('not_reported')
    expect((await row(before)).detail.listedAt).toBe(readAt.toISOString())
    // Nor is the retry called absent by a reading from before it began.
    await noteListed(h.db, to.id, { online: 0, players: [] }, readAt)
    expect((await row(retry)).detail).toEqual({})
  }, 30_000)

  test('finds a Bedrock player under the name Floodgate lists them by', async () => {
    const to = await running('Bedrock')
    // The join names the gamertag; the server lists Floodgate's name and UUID for it.
    const gamertag = 'Kai Sunny'
    const listed = { name: floodgateName(gamertag), uuid: floodgateUuid('2535412345678901') }
    const bedrock = await handed(to, { name: 'Kai_Sunny', uuid: randomUUID() }, 5 * SECOND_MS)
    await h.minecraft.bedrockLogin(to.id, listed)
    await pass()
    expect((await row(bedrock)).serverSide).toBe('console')

    // A Bedrock player on the list tied to no join may be any waiting join's: none is called absent.
    const other = await running('Bedrock unplaced')
    const waiting = await handed(other, player('Noor'), 90 * SECOND_MS)
    await h.minecraft.bedrockLogin(other.id, listed)
    await pass()
    expect((await row(waiting)).detail).toEqual({})
    h.minecraft.leave(other.id, listed.uuid)
    await pass()
    expect(typeof (await row(waiting)).detail.notListedAt).toBe('string')
  }, 30_000)

  test('looks at the last hour’s open joins of its own server only', async () => {
    const to = await running('Bounded')
    const elsewhere = await running('Elsewhere')
    const kai = player('Kai')
    h.minecraft.join(to.id, kai)
    const old = await handed(to, kai, 61 * MINUTE_MS)
    const other = await handed(elsewhere, kai, 5 * SECOND_MS)
    const ended = await handed(to, kai, 30 * SECOND_MS)
    await closed(to, ended, 20 * SECOND_MS)
    await pass()
    for (const id of [old, other, ended]) expect((await row(id)).detail.listedAt).toBeUndefined()
  }, 30_000)
})

describe.skipIf(!hasDatabase)('joins that stopped short', () => {
  test('on a server with no reporter: only those its list could have told of', async () => {
    const to = await running('Vanilla')
    // Left before any reading: a login the game refused and a short visit look the same.
    const quick = await handed(to, player('Kai'), 30 * SECOND_MS)
    await closed(to, quick, 25 * SECOND_MS)
    // Seen on the list, then gone.
    const noor = player('Noor')
    const played = await handed(to, noor, 40 * SECOND_MS)
    h.minecraft.join(to.id, noor)
    // Open a pass after it was handed over, never on the list, then gone.
    const stuck = await handed(to, player('Sunny'), 90 * SECOND_MS)
    await pass()
    h.minecraft.leave(to.id, noor.uuid)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await closed(to, played, 0)
    // Still open, the stuck one isn't listed yet: its mark stands only once its end is known.
    expect(await stoppedShort(to)).toEqual([])
    await closed(to, stuck, 0)
    // Turned away at the edge, and gone from the waiting room: never handed over.
    const refused = await handed(to, player('Efe'), 10 * SECOND_MS, {
      path: 'refused',
      handedAt: undefined,
      leftReason: 'refused:wrong_game',
      leftAt: ago(10 * SECOND_MS),
    })
    const gaveUp = await handed(to, player('Kai'), 10 * SECOND_MS, {
      path: 'held',
      handedAt: undefined,
      leftReason: 'gave_up_waiting',
      leftAt: ago(5 * SECOND_MS),
    })

    expect((await stoppedShort(to)).sort()).toEqual([stuck, refused, gaveUp].sort())
    // Neither stopped short nor in the world: nobody could have told of the quick one.
    const [view] = await h.app.joins
      .list({ server: to.id, limit: 500 })
      .then((all) => all.filter((join) => join.id === quick))
    expect(view).toMatchObject({
      serverSide: 'not_reported',
      inWorldAt: null,
      listedAt: null,
      notListedAt: null,
    })
  }, 30_000)

  test('on a server with a reporter: every join not in the world, as before the list was read', async () => {
    const to = await running('Paper')
    const now = new Date()
    await h.app.joins.recordServerEvents(to.id, [{ kind: 'boot', at: ago(5 * MINUTE_MS) }])
    expect(await h.app.vitals.record(to.id, [sampleAt(ago(30 * SECOND_MS))], now)).toBe(1)
    const told = (kind: ServerJoinEvent['kind'], who: { name: string; uuid: string }, msAgo: number) =>
      ({ kind, at: ago(msAgo), uuid: who.uuid, name: who.name }) satisfies ServerJoinEvent

    // Never logged in, its account refused or its client gone: the reporter told of nothing.
    const silent = await handed(to, player('Kai'), 30 * SECOND_MS)
    await closed(to, silent, 28 * SECOND_MS)
    // Logged in and gone before the world.
    const noor = player('Noor')
    const loading = await handed(to, noor, 30 * SECOND_MS)
    await h.app.joins.recordServerEvents(to.id, [told('login', noor, 29 * SECOND_MS)])
    await closed(to, loading, 20 * SECOND_MS)
    // In the world.
    const sunny = player('Sunny')
    const inWorld = await handed(to, sunny, 30 * SECOND_MS)
    await h.app.joins.recordServerEvents(to.id, [
      told('login', sunny, 29 * SECOND_MS),
      told('in_world', sunny, 27 * SECOND_MS),
    ])
    h.minecraft.join(to.id, sunny)
    // Still open and not in the world yet; turned away at the edge.
    const open = await handed(to, player('Efe'), 5 * SECOND_MS)
    const refused = await handed(to, player('Kai'), 10 * SECOND_MS, {
      path: 'refused',
      handedAt: undefined,
      leftReason: 'refused:busy',
      leftAt: ago(10 * SECOND_MS),
    })
    await pass()

    // What the filter was before a list was ever read, word for word.
    const before = await h.db
      .select({ id: joins.id })
      .from(joins)
      .where(
        and(
          eq(joins.serverId, to.id),
          sql`${joins.kind} = 'join' and (${joins.inWorldAt} is null or ${joins.leftReason} like 'refused:%')`,
        ),
      )
    const listed = await stoppedShort(to)
    expect(listed.sort()).toEqual(before.map((join) => join.id).sort())
    expect(listed.sort()).toEqual([silent, loading, open, refused].sort())
    expect(listed).not.toContain(inWorld)
  }, 30_000)
})

describe.skipIf(!hasDatabase)('a server read as having a reporter', () => {
  /** A join handed to `to` that ended two seconds later, the server telling of no login; its row. */
  const silent = async (to: Server, name: string) => {
    const id = await handed(to, player(name), 30 * SECOND_MS)
    await closed(to, id, 28 * SECOND_MS)
    return row(id)
  }

  test('is one whose reporter told of its boot, until its console is what reads its ticks', async () => {
    const to = await running('Was Paper')
    await h.db
      .insert(schema.serverAccess)
      .values({ serverId: to.id, whitelistEnabled: true })
      .onConflictDoUpdate({ target: schema.serverAccess.serverId, set: { whitelistEnabled: true } })
    await h.app.joins.recordServerEvents(to.id, [{ kind: 'boot', at: ago(5 * MINUTE_MS) }])

    // With a reporter: one that never logged in has no reason, since the game reads its whitelist
    // after the login the reporter would have told of; and it stopped short.
    const first = await silent(to, 'Kai')
    expect(first.leftReason).toBeNull()
    expect(await stoppedShort(to)).toEqual([first.id])

    // It left Paper: no reporter samples it, so the pass reads its ticks over its console.
    await pass()
    const [newest] = await h.db
      .select({ source: schema.serverVitals.source })
      .from(schema.serverVitals)
      .where(eq(schema.serverVitals.serverId, to.id))
    expect(newest?.source).toBe('console')
    // Read as a server with none: by its lists alone, and nobody could have told of the first.
    const second = await silent(to, 'Noor')
    expect(second.leftReason).toBe('refused:whitelist')
    expect(await stoppedShort(to)).toEqual([second.id])

    // A join its list showed in the world was let in, whatever its whitelist says now.
    const sunny = player('Sunny')
    const played = await handed(to, sunny, 20 * SECOND_MS)
    h.minecraft.join(to.id, sunny)
    await pass()
    h.minecraft.leave(to.id, sunny.uuid)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await closed(to, played, 0)
    expect(await row(played)).toMatchObject({ serverSide: 'console', leftReason: null })

    // Back on Paper, its reporter sampling it again.
    expect(await h.app.vitals.record(to.id, [sampleAt(new Date().toISOString())])).toBe(1)
    const third = await silent(to, 'Efe')
    expect(third.leftReason).toBeNull()
    expect((await stoppedShort(to)).sort()).toEqual([first.id, second.id, third.id].sort())
  }, 30_000)
})

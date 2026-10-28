// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A join the game turned away for its own lists says so once the edge reports it ended and the
 * server told of its login, in either order: the whitelist, where the player is on neither it nor
 * the operators, and a ban, read first. On a server with no reporter, by its lists alone. Nothing
 * else is given a reason: a join that never logged in on a server that reports, one that reached
 * the world, one the edge turned away, one the server already explained, or one whose player
 * nobody knows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { ServerJoinEvent, VisitReport } from '@blockly/contracts/join-records'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { offlineUuid } from '../access/identity.ts'

const STEVE = { name: 'Steve', uuid: '8667ba71-b85a-4004-af54-457a9734eed7' }
const t0 = Date.parse('2026-10-21T10:00:00.000Z')
const at = (ms: number) => new Date(t0 + ms).toISOString()
/** The server's word that Steve logged in: his account verified, before the game reads its lists. */
const login: ServerJoinEvent = { kind: 'login', at: at(100), uuid: STEVE.uuid, name: STEVE.name }

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  await h?.close()
})

type List = 'whitelist' | 'operator' | 'ban'
type Entry = { list: List; uuid?: string; state?: 'active' | 'pending_add' | 'pending_remove' }

/** A server of its own, its whitelist on or off, with Steve on the lists given; one that reports, unless not. */
const server = async (whitelist: boolean, lists: Entry[] = [], reports = true) => {
  const made = await h.create(await h.user(), { name: 'Refusals' })
  if (reports) await h.app.joins.recordServerEvents(made.id, [{ kind: 'boot', at: at(0) }])
  const access = schema.serverAccess
  await h.db
    .insert(access)
    .values({ serverId: made.id, whitelistEnabled: whitelist })
    .onConflictDoUpdate({ target: access.serverId, set: { whitelistEnabled: whitelist } })
  for (const entry of lists)
    await h.db.insert(schema.serverAccessEntries).values({
      serverId: made.id,
      list: entry.list,
      playerUuid: entry.uuid ?? STEVE.uuid,
      playerName: STEVE.name,
      state: entry.state ?? 'active',
      origin: 'blockly',
    })
  return { id: made.id, address: `${(await h.server(made.id)).slug}.play.test` }
}

/** Steve's join to `to`, handed over, logged in and ended as the edge reports it; its reason after. */
const ended = async (
  to: { id: string; address: string },
  fields: Partial<VisitReport> = {},
  events: ServerJoinEvent[] = [login],
) => {
  const joinId = randomUUID()
  const visit = { joinId, edgeId: 'edge-1', region: 'fra', address: to.address, source: '203.0.113.7:50001' }
  const half = { ...visit, connectedAt: at(0), player: STEVE, path: 'direct' as const, handedAt: at(30) }
  await h.app.joins.recordVisits([{ ...half, phase: 'open', ...fields }])
  if (events.length > 0) await h.app.joins.recordServerEvents(to.id, events)
  await h.app.joins.recordVisits([{ ...half, phase: 'close', leftAt: at(900), ...fields }])
  const [row] = await h.db.select().from(schema.joins).where(eq(schema.joins.id, joinId))
  return row?.leftReason ?? null
}

describe.skipIf(!hasDatabase)('a join the game refused', () => {
  test('for its whitelist, when the player is on neither it nor the operators', async () => {
    expect(await ended(await server(true))).toBe('refused:whitelist')
    // Waiting to be added is not on it yet, as far as the game knows.
    expect(await ended(await server(true, [{ list: 'whitelist', state: 'pending_add' }]))).toBe(
      'refused:whitelist',
    )
    expect(await ended(await server(true, [{ list: 'whitelist' }]))).toBeNull()
    // The game lets an operator past its whitelist, and one whose removal hasn't reached it.
    expect(await ended(await server(true, [{ list: 'operator' }]))).toBeNull()
    expect(await ended(await server(true, [{ list: 'whitelist', state: 'pending_remove' }]))).toBeNull()
    expect(await ended(await server(false))).toBeNull()
  }, 30_000)

  test('for a ban, read before the whitelist, as the game reads it', async () => {
    expect(await ended(await server(false, [{ list: 'ban' }]))).toBe('refused:banned')
    expect(await ended(await server(true, [{ list: 'whitelist' }, { list: 'ban' }]))).toBe('refused:banned')
  }, 30_000)

  test('on a server that does not check accounts, by the UUID it makes from the name', async () => {
    const own = offlineUuid(STEVE.name)
    expect(await ended(await server(true, [{ list: 'whitelist', uuid: own }]))).toBeNull()
    expect(await ended(await server(false, [{ list: 'ban', uuid: own }]))).toBe('refused:banned')
  }, 30_000)

  test('on a server with no reporter, by its lists alone', async () => {
    const vanilla = await server(true, [], false)
    expect(await ended(vanilla, {}, [])).toBe('refused:whitelist')
    expect(await ended(vanilla, { handedAt: undefined }, [])).toBeNull()
    // Once on the whitelist, the same server lets him past it.
    await h.db.insert(schema.serverAccessEntries).values({
      serverId: vanilla.id,
      list: 'whitelist',
      playerUuid: STEVE.uuid,
      playerName: STEVE.name,
      state: 'active',
      origin: 'blockly',
    })
    expect(await ended(vanilla, {}, [])).toBeNull()
  }, 30_000)

  test('once the server tells of the login, when the edge told of the end first', async () => {
    const to = await server(true)
    const joinId = randomUUID()
    const visit = {
      joinId,
      edgeId: 'edge-1',
      region: 'fra',
      address: to.address,
      source: '203.0.113.7:50002',
    }
    const half = { ...visit, connectedAt: at(0), player: STEVE, path: 'direct' as const, handedAt: at(30) }
    await h.app.joins.recordVisits([{ ...half, phase: 'open' }])
    await h.app.joins.recordVisits([{ ...half, phase: 'close', leftAt: at(900) }])
    const reason = async () =>
      (await h.db.select().from(schema.joins).where(eq(schema.joins.id, joinId)))[0]?.leftReason ?? null
    expect(await reason()).toBeNull()
    await h.app.joins.recordServerEvents(to.id, [login])
    expect(await reason()).toBe('refused:whitelist')
  }, 30_000)

  test('and nothing else is given a reason', async () => {
    // Each on a server of its own, its whitelist on and Steve not on it, so one join's events
    // can't be matched to another's.
    const closed = () => server(true)
    // Never logged in: the game refused the account before it read its lists, or the client left.
    // With no word from the server, these can share one.
    const quiet = await closed()
    expect(await ended(quiet, {}, [])).toBeNull()
    // In the world: the game let them in.
    const inWorld = { kind: 'in_world' as const, at: at(500), uuid: STEVE.uuid, name: STEVE.name }
    expect(await ended(await closed(), {}, [inWorld])).toBeNull()
    // The server's own word of why they left stands.
    const left = { kind: 'left' as const, at: at(600), uuid: STEVE.uuid, name: STEVE.name, reason: 'kicked' }
    expect(await ended(await closed(), {}, [inWorld, left])).toBe('kicked')
    // Turned away at the edge, with its own reason; never handed over; nobody to look for.
    const refused = { path: 'refused' as const, handedAt: undefined, leftReason: 'refused:wrong_game' }
    expect(await ended(quiet, refused, [])).toBe('refused:wrong_game')
    expect(await ended(quiet, { handedAt: undefined }, [])).toBeNull()
    expect(await ended(quiet, { player: { name: STEVE.name } }, [])).toBeNull()
  }, 30_000)
})

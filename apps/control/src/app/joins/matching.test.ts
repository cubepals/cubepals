// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One join as one row, whichever half comes first: the edge's visit reports and the server's own
 * events matched by the client's source, else by the player; a late close, a look, the reporter's
 * route and its limits, and the sweep that forgets sources and old rows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import type { ServerJoinEvent, VisitReport } from '@blockly/contracts/join-records'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { createJoinsApp } from '../../interfaces/runtime/joins.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { deriveServerSecret, singleKey } from '../secrets.ts'
import { installTuning, tuning } from '../tuning.ts'

const STEVE = { name: 'Steve', uuid: '8667ba71-b85a-4004-af54-457a9734eed7' }
const ALEX = { name: 'Alex', uuid: '6ab43178-89fd-4905-8c45-9f2f4ad1c2a5' }
const t0 = new Date('2026-10-20T10:00:00.000Z')
const at = (ms: number) => new Date(t0.getTime() + ms).toISOString()

let h: Harness
let serverId: string
let address: string

beforeAll(async () => {
  if (!hasDatabase) return
  h = await startHarness()
  const made = await h.create(await h.user(), { name: 'Matching' })
  serverId = made.id
  address = `${(await h.server(made.id)).slug}.play.test`
}, 30_000)

afterAll(async () => {
  await h?.close()
})

const visit = (joinId: string, fields: Partial<VisitReport>): VisitReport => ({
  joinId,
  phase: 'open',
  edgeId: 'edge-1',
  region: 'fra',
  address,
  source: '203.0.113.9:50001',
  connectedAt: at(0),
  ...fields,
})
const row = async (id: string) => {
  const [found] = await h.db.select().from(schema.joins).where(eq(schema.joins.id, id))
  if (found === undefined) throw new Error(`no join ${id}`)
  return found
}
const event = (kind: ServerJoinEvent['kind'], ms: number, fields: Partial<ServerJoinEvent> = {}) =>
  ({ kind, at: at(ms), uuid: STEVE.uuid, name: STEVE.name, ...fields }) as ServerJoinEvent

describe.skipIf(!hasDatabase)('the halves of a join', () => {
  test('the edge first, then the server: matched by source', async () => {
    const id = randomUUID()
    const source = '203.0.113.9:50001'
    await h.app.joins.recordVisits([
      visit(id, { player: STEVE, path: 'direct', handedAt: at(40), protocol: 773 }),
    ])
    await h.app.joins.recordServerEvents(serverId, [
      event('login', 300),
      event('in_world', 2_000, { address: source, tick: { tps: 20, mspt: 12.5, online: 1 } }),
    ])
    const joined = await row(id)
    expect(joined).toMatchObject({
      kind: 'join',
      serverId,
      addressKind: 'own',
      path: 'direct',
      playerUuid: STEVE.uuid,
      protocol: 773,
      serverSide: 'reported',
      tick: { tps: 20, mspt: 12.5, online: 1 },
    })
    expect(joined.loginAt?.toISOString()).toBe(at(300))
    expect(joined.inWorldAt?.toISOString()).toBe(at(2_000))
    expect(joined.network).not.toBeNull()
    expect(joined.network).not.toContain('203.0.113')
  })

  test('without a source the server knew, by the player the edge handed over moments before', async () => {
    const id = randomUUID()
    await h.app.joins.recordVisits([
      visit(id, { source: '198.51.100.4:40000', player: ALEX, handedAt: at(5_000), connectedAt: at(4_900) }),
    ])
    await h.app.joins.recordServerEvents(serverId, [
      event('login', 5_200, { uuid: ALEX.uuid, name: ALEX.name }),
      // From a server that reads no PROXY header, its source is the edge's own.
      event('in_world', 95_000, { uuid: ALEX.uuid, name: ALEX.name, address: '10.0.0.1:1234' }),
    ])
    const joined = await row(id)
    expect(joined.loginAt?.toISOString()).toBe(at(5_200))
    expect(joined.inWorldAt?.toISOString()).toBe(at(95_000))
  })

  test('the server first, then the edge: the edge takes the server’s row', async () => {
    const before = await h.db.select().from(schema.joins)
    await h.app.joins.recordServerEvents(serverId, [
      event('login', 600_000, { uuid: ALEX.uuid, name: ALEX.name }),
    ])
    const orphan = (await h.db.select().from(schema.joins)).filter((r) => !before.some((b) => b.id === r.id))
    expect(orphan).toHaveLength(1)
    expect(orphan[0]?.detail).toEqual({ edge: 'missing' })
    expect(orphan[0]?.address).toBe(address)
    // A signal raised on the server's row before the edge's half came.
    const key = `slow_join:${orphan[0]?.id}:login`
    await h.db
      .insert(schema.signals)
      .values({ kind: 'slow_join', key, at: new Date(), joinId: orphan[0]?.id })

    const id = randomUUID()
    await h.app.joins.recordVisits([
      visit(id, {
        source: '198.51.100.4:40001',
        player: ALEX,
        connectedAt: at(599_800),
        handedAt: at(599_900),
      }),
    ])
    const joined = await row(id)
    expect(joined.detail).toEqual({})
    expect(joined.connectedAt.toISOString()).toBe(at(599_800))
    expect(joined.loginAt?.toISOString()).toBe(at(600_000))
    const [signal] = await h.db.select().from(schema.signals).where(eq(schema.signals.key, key))
    expect(signal?.joinId).toBe(id)
    expect((await h.db.select().from(schema.joins)).length).toBe(before.length + 1)
  })

  test('a late close fills only what is empty, and the earliest leaving stands', async () => {
    const id = randomUUID()
    const source = '203.0.113.20:51000'
    await h.app.joins.recordVisits([
      visit(id, { source, player: STEVE, path: 'direct', handedAt: at(1_200_000) }),
    ])
    await h.app.joins.recordServerEvents(serverId, [
      event('left', 1_260_000, { address: source, reason: 'disconnected' }),
    ])
    await h.app.joins.recordVisits([
      visit(id, {
        phase: 'close',
        source,
        path: 'held',
        handedAt: at(1),
        leftAt: at(1_261_000),
        leftReason: 'closed',
        pingedAfterAt: at(1_300_000),
        bytesUp: 4_000,
        bytesDown: 900_000,
      }),
    ])
    const left = await row(id)
    expect(left.path).toBe('direct')
    expect(left.handedAt?.toISOString()).toBe(at(1_200_000))
    expect(left.leftAt?.toISOString()).toBe(at(1_260_000))
    expect(left.leftReason).toBe('disconnected')
    expect(left.pingedAfterAt?.toISOString()).toBe(at(1_300_000))
    expect([left.bytesUp, left.bytesDown]).toEqual([4_000, 900_000])
    // Both halves told, and the player gone: the source was kept only to put them together.
    expect(left.source).toBeNull()
  })
})

describe.skipIf(!hasDatabase)('when the edge’s close comes first', () => {
  test('the server’s events still find the join, by source or by the player, and nothing else', async () => {
    const id = randomUUID()
    const source = '203.0.113.40:52000'
    const before = (await h.db.select().from(schema.joins)).length
    await h.app.joins.recordVisits([
      visit(id, {
        source,
        player: STEVE,
        path: 'direct',
        connectedAt: at(3_000_000),
        handedAt: at(3_000_050),
      }),
      visit(id, {
        phase: 'close',
        source,
        leftAt: at(3_030_000),
        leftReason: 'closed',
        bytesUp: 1,
        bytesDown: 2,
      }),
    ])
    // A batch the server sent late: its login (no address), in the world, and leaving.
    await h.app.joins.recordServerEvents(serverId, [
      event('login', 3_000_400),
      event('in_world', 3_002_000, { address: source }),
      event('left', 3_029_900, { address: source, reason: 'disconnected' }),
    ])
    const joined = await row(id)
    expect(joined).toMatchObject({ serverSide: 'reported', leftReason: 'closed', source: null })
    expect(joined.loginAt?.toISOString()).toBe(at(3_000_400))
    expect(joined.inWorldAt?.toISOString()).toBe(at(3_002_000))
    expect(joined.leftAt?.toISOString()).toBe(at(3_029_900))
    expect((await h.db.select().from(schema.joins)).length).toBe(before + 1)
  })
})

describe.skipIf(!hasDatabase)('looks, addresses and forgetting', () => {
  test('a look is a row of its own, and an address no server has reaches none', async () => {
    const look = randomUUID()
    await h.app.joins.recordVisits([
      visit(look, { phase: 'look', pingedAt: at(2_000_000), connectedAt: undefined, detail: { more: 3 } }),
      visit(randomUUID(), { address: 'nobody-here.play.old.test' }),
    ])
    expect(await row(look)).toMatchObject({ kind: 'look', serverId, detail: { more: 3 } })
    expect((await row(look)).connectedAt.toISOString()).toBe(at(2_000_000))
  })

  test('an address on an old play domain says so', async () => {
    const id = randomUUID()
    await h.app.joins.recordVisits([visit(id, { address: address.replace('.play.test', '.play.old.test') })])
    expect(await row(id)).toMatchObject({ serverId, addressKind: 'old_domain' })
  })

  test('the sweep forgets sources before they are an hour old, and rows past 35 days', async () => {
    const now = new Date()
    const recent = randomUUID()
    const hourOld = randomUUID()
    const nearlyHour = randomUUID()
    const old = randomUUID()
    await h.app.joins.recordVisits([
      visit(recent, {
        source: '203.0.113.30:1',
        connectedAt: new Date(now.getTime() - 5 * SECOND_MS).toISOString(),
      }),
      visit(hourOld, {
        source: '203.0.113.31:1',
        connectedAt: new Date(now.getTime() - 2 * HOUR_MS).toISOString(),
      }),
      // An hour old before the next sweep, ten minutes on.
      visit(nearlyHour, {
        source: '203.0.113.33:1',
        connectedAt: new Date(now.getTime() - 55 * MINUTE_MS).toISOString(),
      }),
      visit(old, {
        source: '203.0.113.32:1',
        connectedAt: new Date(now.getTime() - 36 * DAY_MS).toISOString(),
      }),
    ])
    await h.db
      .insert(schema.signals)
      .values({ kind: 'short_stay', key: `old:${old}`, at: new Date(now.getTime() - 36 * DAY_MS) })
    expect(await h.app.joins.sweep(now)).toBeGreaterThanOrEqual(3)
    expect((await row(recent)).source).toBe('203.0.113.30:1')
    expect((await row(hourOld)).source).toBeNull()
    expect((await row(nearlyHour)).source).toBeNull()
    expect(await h.db.select().from(schema.joins).where(eq(schema.joins.id, old))).toEqual([])
    expect(
      await h.db
        .select()
        .from(schema.signals)
        .where(eq(schema.signals.key, `old:${old}`)),
    ).toEqual([])
  })
})

describe.skipIf(!hasDatabase)('the reporter’s route', () => {
  test('the reporter’s route takes the server’s own token, so much and so often', async () => {
    const app = createJoinsApp({ artifacts: h.app.artifacts, joins: h.app.joins })
    const token = deriveServerSecret(
      singleKey('test-runtime-secrets-key-0123456789').current.key,
      serverId,
      'artifacts',
    )
    const post = (body: unknown, t = token) =>
      app.request(`/runtime/v1/servers/${serverId}/joins?t=${t}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const boot = { kind: 'boot', at: at(0), detail: { paper: '1.21.8', loginListeners: ['Old'] } }
    expect((await post({ events: [boot] }, 'not-its-token')).status).toBe(403)
    expect((await post({ events: [boot] })).status).toBe(204)
    const [report] = await h.db
      .select()
      .from(schema.serverReports)
      .where(eq(schema.serverReports.serverId, serverId))
    expect(report?.detail).toEqual(boot.detail)
    const padded = (n: number) => ({ events: [{ ...boot, detail: { pad: 'x'.repeat(n) } }] })
    expect((await post(padded(70_000))).status).toBe(413)
    const statuses = await Promise.all(Array.from({ length: 12 }, () => post({ events: [] })))
    expect(statuses.filter((r) => r.status === 429).length).toBeGreaterThan(0)
    // The limits are the deployment's own, from ABUSE_LIMITS.
    const deployed = tuning()
    installTuning({
      ...deployed,
      abuse: { ...deployed.abuse, joinReportBytes: 1_000, joinReportsPerSecond: 1 },
    })
    try {
      expect((await post(padded(2_000))).status).toBe(413)
      await Bun.sleep(SECOND_MS)
      const [first, second] = [await post({ events: [] }), await post({ events: [] })]
      expect([first.status, second.status]).toEqual([204, 429])
    } finally {
      installTuning(deployed)
    }
  })
})

describe.skipIf(!hasDatabase)('a server that doesn’t check accounts', () => {
  // It gives each player a UUID of its own, not the one the client told the edge, as staging showed.
  const told = { name: 'TraceBot', uuid: '00000000-0000-0000-0000-000000000000' }
  const own = { uuid: '5b782a77-1327-30ea-9f07-b18ec415fe82', name: 'tracebot' }

  test('the server’s login first, then the edge: one row, found by the name', async () => {
    const before = (await h.db.select().from(schema.joins)).length
    await h.app.joins.recordServerEvents(serverId, [event('login', 900_100, own)])
    const id = randomUUID()
    const source = '198.51.100.7:40007'
    await h.app.joins.recordVisits([
      visit(id, { source, player: told, connectedAt: at(898_500), handedAt: at(900_020) }),
    ])
    await h.app.joins.recordServerEvents(serverId, [event('in_world', 917_000, { ...own, address: source })])
    const joined = await row(id)
    expect(joined.detail).toEqual({})
    expect(joined.loginAt?.toISOString()).toBe(at(900_100))
    expect(joined.inWorldAt?.toISOString()).toBe(at(917_000))
    expect((await h.db.select().from(schema.joins)).length).toBe(before + 1)
  })

  test('the edge first, then the server’s login: found by the name', async () => {
    const id = randomUUID()
    await h.app.joins.recordVisits([
      visit(id, {
        source: '198.51.100.8:40008',
        player: told,
        connectedAt: at(1_200_000),
        handedAt: at(1_201_000),
      }),
    ])
    await h.app.joins.recordServerEvents(serverId, [event('login', 1_201_100, own)])
    expect((await row(id)).loginAt?.toISOString()).toBe(at(1_201_100))
  })
})

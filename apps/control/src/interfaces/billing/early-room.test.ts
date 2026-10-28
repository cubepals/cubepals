// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The room for early checkouts, as an operator sets it through its own route: its token and
 * nothing else opens it, room above the cap and settings that reach too far are refused, room past
 * its time counts as none, it counts from when its figures were read, and each change of room or
 * points is audited while a renewal isn't.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { EarlyRoomControl, readEarlyRoom, roomNow } from '../../app/billing/early-room.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { createEarlyRoomRoute, EARLY_ROOM_PATH } from './early-room.ts'

const TOKEN = 'early-room-token-0123456789abcdef'
const CAP = 5000

describe.skipIf(!hasDatabase)('the room for early checkouts', () => {
  let h: Harness
  let route: ReturnType<typeof createEarlyRoomRoute>

  beforeAll(async () => {
    h = await startHarness()
    route = createEarlyRoomRoute({ room: new EarlyRoomControl({ db: h.db, maxPoints: CAP }), token: TOKEN })
  }, 30_000)

  afterAll(() => h.close())

  const inAWhile = (minutes = 60) => new Date(Date.now() + minutes * MINUTE_MS).toISOString()
  const setting = (patch: Record<string, unknown> = {}) => ({
    roomPoints: 1200,
    points: { core: 300, plus: 900 },
    validUntil: inAWhile(),
    ...patch,
  })
  const put = (body: unknown, authorization = `Bearer ${TOKEN}`) =>
    route.request(EARLY_ROOM_PATH, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const audited = () =>
    h.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'billing.early_room_set'),
          eq(schema.auditLog.subjectId, 'early_room'),
        ),
      )

  test('is none until it is set', async () => {
    const room = await readEarlyRoom(h.db)
    expect(room).toMatchObject({ roomPoints: 0, validUntil: null })
    expect(roomNow(room, new Date())).toBe(0)
  })

  test('only its own token sets it', async () => {
    for (const authorization of ['', 'Bearer nope', `Bearer ${TOKEN.replace('0', '1')}`, TOKEN])
      expect((await put(setting(), authorization)).status).toBe(401)
    expect((await readEarlyRoom(h.db)).roomPoints).toBe(0)
  })

  test('holds what it is set to until its time, and none after', async () => {
    const until = inAWhile(30)
    const answer = await put(setting({ validUntil: until }))
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({ roomPoints: 1200, points: { core: 300, plus: 900 } })
    const room = await readEarlyRoom(h.db)
    expect(room.validUntil?.toISOString()).toBe(new Date(until).toISOString())
    expect(roomNow(room, new Date())).toBe(1200)
    expect(roomNow(room, new Date(Date.now() + 31 * MINUTE_MS))).toBe(0)
  })

  test('counts from when its figures were read, where the setter says', async () => {
    const readAt = inAWhile(-2)
    expect((await put(setting({ readAt }))).status).toBe(200)
    expect((await readEarlyRoom(h.db)).setAt?.toISOString()).toBe(readAt)
  })

  test('refuses room past the cap, points no checkout could take, and times too far or gone', async () => {
    const before = await readEarlyRoom(h.db)
    for (const refused of [
      setting({ roomPoints: CAP + 1 }),
      setting({ roomPoints: -1 }),
      setting({ points: { core: 0, plus: 900 } }),
      setting({ points: { core: 300, plus: CAP + 1 } }),
      setting({ validUntil: inAWhile(-1) }),
      setting({ validUntil: inAWhile(3 * 60) }),
      setting({ readAt: inAWhile(1) }),
      setting({ readAt: inAWhile(-61) }),
      { roomPoints: 10 },
    ])
      expect((await put(refused)).status).toBe(400)
    expect(await readEarlyRoom(h.db)).toEqual(before)
  })

  test('audits a change of room or points, and not a renewal of the same', async () => {
    const before = (await audited()).length
    await put(setting({ roomPoints: 800 }))
    await put(setting({ roomPoints: 800, validUntil: inAWhile(45) }))
    await put(setting({ roomPoints: 800, points: { core: 250, plus: 900 } }))
    const rows = await audited()
    expect(rows.length - before).toBe(2)
    expect(rows.at(-1)).toMatchObject({
      actor: 'system:early-room',
      data: { to: { roomPoints: 800, points: { core: 250, plus: 900 } } },
    })
  })
})

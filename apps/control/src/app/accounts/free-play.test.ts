// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One person, one set of free hours, through the control plane as it runs: a server's verified
 * play is counted from its own readings; a visiting friend, a group with two genuine accounts, a
 * shared address and offline-mode names link nothing; one main player on two accounts is shown to
 * admins and changes nothing, and on three is sure enough that they share the first one's hours,
 * the day's and the 20, on the audit log, until a release that holds; one inbox's accounts share
 * at once; and an admin's hold stops free starts and deletes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DAY_MS, HOUR_S, MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq, inArray } from 'drizzle-orm'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { recordEdgePresence, replacePresence } from '../servers/usage.ts'
import { tuning } from '../tuning.ts'
import { freeSharers } from './free-play.ts'
import { loadStanding } from './persistence.ts'
import { playTotal } from './play-total.ts'

let h: Harness

/** A harness of its own for each part, so the links one part makes don't reach another. */
function harness(): void {
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })
}

/** Accounts made in this file, a week apart from each other, so which came first is never a tie. */
let made = 0
const owner = async (plan = 'free') => {
  const actor = await h.user('Steve', plan)
  await h.db
    .update(schema.users)
    .set({ createdAt: new Date(Date.now() - (100 - made++) * 7 * DAY_MS) })
    .where(eq(schema.users.id, actor.userId))
  return actor
}
const admin = async () => ({ kind: 'admin' as const, userId: (await h.user('Staff')).userId })

/** A server of the owner's, made, run and stopped again: ready to be started. */
const stopped = async (actor: UserActor) => {
  const server = await h.create(actor)
  await h.until(server.id, 'running')
  await h.settled(server.id)
  await h.app.servers.stop(actor, server.id, randomUUID())
  await h.until(server.id, 'stopped')
  await h.settled(server.id)
  return server
}
/** The server ran `minutes` on Free that ended just now. */
const ran = (serverId: string, minutes: number) =>
  h.db.insert(schema.powerIntervals).values({
    serverId,
    memoryTier: '3g',
    plan: 'free',
    startedAt: new Date(Date.now() - minutes * MINUTE_MS - MINUTE_MS),
    stoppedAt: new Date(Date.now() - MINUTE_MS),
  })
/** The server itself said these players were on. */
const seen = (serverId: string, players: readonly string[], at = new Date()) =>
  replacePresence(
    h.db,
    serverId,
    players.map((uuid, i) => ({ uuid, name: `Player${i}` })),
    at,
  )
/** Each player's play on the server, in hours, as its own readings would have counted it. */
const verified = async (serverId: string, hours: Record<string, number>) => {
  await seen(serverId, Object.keys(hours))
  for (const [uuid, played] of Object.entries(hours))
    await h.db
      .update(schema.serverPlayers)
      .set({ playedSeconds: Math.round(played * HOUR_S) })
      .where(and(eq(schema.serverPlayers.serverId, serverId), eq(schema.serverPlayers.playerUuid, uuid)))
}
/** An offline-mode player's ID: made from a name, version 3. */
const offline = () => `${randomUUID().slice(0, 14)}3${randomUUID().slice(15)}`
/** The free trial's hours in all, as the account counts them. */
const total = async (actor: UserActor) => {
  const standing = await loadStanding(h.db, actor.userId)
  return playTotal(h.db, standing, entitlementsFor(standing.plan), new Date())
}
const sharers = async (actor: UserActor) => (await freeSharers(h.db, actor.userId, new Date())).ids.sort()
const linksAmong = (actors: readonly UserActor[]) =>
  h.db
    .select()
    .from(schema.freeLinks)
    .where(
      inArray(
        schema.freeLinks.accountId,
        actors.map((a) => a.userId),
      ),
    )
const logged = (subjectId: string, action: string) =>
  h.db
    .select({ data: schema.auditLog.data, actor: schema.auditLog.actor })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectId, subjectId), eq(schema.auditLog.action, action)))

describe.skipIf(!hasDatabase)('verified play', () => {
  harness()

  test('is the time between two of the server’s own readings that both find someone on', async () => {
    const actor = await owner()
    const server = await stopped(actor)
    const [steve, door] = [randomUUID(), randomUUID()]
    const start = Date.now() - 30 * MINUTE_MS
    await seen(server.id, [steve], new Date(start))
    await seen(server.id, [steve], new Date(start + MINUTE_MS))
    await seen(server.id, [steve], new Date(start + 2 * MINUTE_MS))
    // Away for ten minutes and back: the time away isn't play.
    await seen(server.id, [steve], new Date(start + 12 * MINUTE_MS))
    // Only the door heard of this one: never verified.
    await recordEdgePresence(h.db, server.id, { uuid: door, name: 'Door' }, 'connect', new Date())
    const rows = await h.db
      .select()
      .from(schema.serverPlayers)
      .where(eq(schema.serverPlayers.serverId, server.id))
    const byUuid = new Map(rows.map((row) => [row.playerUuid, row]))
    expect(byUuid.get(steve)?.playedSeconds).toBe((2 * MINUTE_MS) / SECOND_MS)
    expect(byUuid.get(door)).toMatchObject({ playedSeconds: 0, confirmedAt: null })
  }, 60_000)
})

describe.skipIf(!hasDatabase)('what links nothing', () => {
  harness()

  test('a visiting friend, each on the other’s world for an hour', async () => {
    const [alice, bob, carol] = [randomUUID(), randomUUID(), randomUUID()]
    const a = await owner()
    const b = await owner()
    const c = await owner()
    await verified((await stopped(a)).id, { [alice]: 10, [bob]: 1, [carol]: 2 })
    await verified((await stopped(b)).id, { [bob]: 10, [alice]: 1 })
    await verified((await stopped(c)).id, { [carol]: 5 })
    expect(await h.app.accounts.freePlay.relink()).toBe(0)
    expect(await linksAmong([a, b, c])).toEqual([])
  }, 90_000)

  test('two genuine accounts in one group, signed up together from one home', async () => {
    const group = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const a = await owner()
    const b = await owner()
    const together = new Date()
    await h.db
      .update(schema.users)
      .set({ createdAt: together })
      .where(inArray(schema.users.id, [a.userId, b.userId]))
    await h.app.accounts.freePlay.signedUp(a.userId, `${randomUUID()}@example.test`, '203.0.113.7')
    await h.app.accounts.freePlay.signedUp(b.userId, `${randomUUID()}@example.test`, '203.0.113.7')
    const [alice, bob, ...rest] = group as [string, string, string, string]
    // Everyone plays alike on one, and each owner a little more on their own on the other.
    await verified((await stopped(a)).id, Object.fromEntries(group.map((p) => [p, 3])))
    await verified((await stopped(b)).id, {
      [bob]: 6,
      [alice]: 4,
      ...Object.fromEntries(rest.map((p) => [p, 1])),
    })
    expect(await h.app.accounts.freePlay.relink()).toBe(0)
    expect(await linksAmong([a, b])).toEqual([])
    expect(await sharers(b)).toEqual([b.userId])
  }, 90_000)

  test('a shared address alone, however many sign up from it', async () => {
    const many = [await owner(), await owner(), await owner(), await owner(), await owner(), await owner()]
    for (const actor of many)
      await h.app.accounts.freePlay.signedUp(actor.userId, `${randomUUID()}@example.test`, '2001:db8:5:6::1')
    expect(await h.app.accounts.freePlay.relink()).toBe(0)
    expect(await linksAmong(many)).toEqual([])
    // The address is kept for `networkKeptMs`, and then forgotten.
    const [row] = await h.db
      .select()
      .from(schema.freePlay)
      .where(eq(schema.freePlay.userId, many[0]?.userId ?? ''))
    expect(row?.signupNetwork).toBe('2001:db8:5:6::/64')
    await h.db
      .update(schema.freePlay)
      .set({ createdAt: new Date(Date.now() - tuning().freeLinks.networkKeptMs - DAY_MS) })
      .where(eq(schema.freePlay.signupNetwork, '2001:db8:5:6::/64'))
    await h.app.accounts.freePlay.relink()
    expect(
      await h.db.select().from(schema.freePlay).where(eq(schema.freePlay.signupNetwork, '2001:db8:5:6::/64')),
    ).toEqual([])
  }, 30_000)

  test('offline-mode names, which anyone can type', async () => {
    const name = offline()
    const a = await owner()
    const b = await owner()
    const c = await owner()
    for (const actor of [a, b, c]) await verified((await stopped(actor)).id, { [name]: 5 })
    await h.app.accounts.freePlay.relink()
    expect(await linksAmong([a, b, c])).toEqual([])
  }, 90_000)
})

describe.skipIf(!hasDatabase)('one main player on several free accounts', () => {
  harness()

  test('on two is shown to admins; on three they share the first one’s hours, until released', async () => {
    const [steve, friend] = [randomUUID(), randomUUID()]
    const staff = await admin()
    const first = await owner()
    const second = await owner()
    const firstServer = await stopped(first)
    await verified(firstServer.id, { [steve]: 4, [friend]: 1 })
    await verified((await stopped(second)).id, { [steve]: 4, [friend]: 1 })
    await ran(firstServer.id, 20 * 60)

    // Two: medium. Admins see it; nothing changes for the accounts.
    expect(await h.app.accounts.freePlay.relink()).toBe(0)
    expect(await h.app.accounts.freePlay.links(staff)).toMatchObject([
      { account: { userId: second.userId }, linked: { userId: first.userId }, shared: false },
    ])
    expect((await h.app.alerts.active(staff)).map((a) => a.key)).toContain('free_accounts_linked')
    expect(await sharers(second)).toEqual([second.userId])
    expect((await total(second))?.left).toBeGreaterThan(19.9)

    // Three: high. The later two draw on the first one's 20 hours.
    const third = await owner()
    const thirdServer = await stopped(third)
    await verified(thirdServer.id, { [steve]: 4, [friend]: 1 })
    expect(await h.app.accounts.freePlay.relink()).toBe(2)
    expect(await sharers(third)).toEqual([first.userId, second.userId, third.userId].sort())
    expect(await total(third)).toMatchObject({ left: 0 })
    expect((await total(third))?.units).toBeCloseTo(20, 1)
    await expect(h.app.servers.start(third, thirdServer.id, randomUUID())).rejects.toMatchObject({
      code: 'limit_reached',
      message: expect.stringContaining(
        'Your free trial is shared with another Cubepals account the same player plays on.',
      ),
    })
    for (const later of [second, third])
      expect(await logged(later.userId, 'account.free_linked')).toEqual([
        { actor: 'system:free-play', data: { with: first.userId, confidence: expect.any(Number) } },
      ])
    expect(await logged(first.userId, 'account.free_linked')).toEqual([])

    // A release holds: the third has its own hours, and the next pass doesn't link it again.
    await h.app.accounts.freePlay.release(staff, third.userId)
    expect(await sharers(third)).toEqual([third.userId])
    expect(await h.app.accounts.freePlay.relink()).toBe(0)
    expect(await sharers(third)).toEqual([third.userId])
    expect(await sharers(second)).toEqual([second.userId])
    await h.app.servers.start(third, thirdServer.id, randomUUID())
    await h.until(thirdServer.id, 'running')
    await h.settled(thirdServer.id)
  }, 120_000)
})

describe.skipIf(!hasDatabase)('one inbox’s accounts', () => {
  harness()

  test('share at once, both ways, and a paid one counts in nobody’s', async () => {
    const [first, second, paid] = [await owner(), await owner(), await owner('plus')]
    await h.app.accounts.freePlay.signedUp(first.userId, 'steve@example.test')
    await h.app.accounts.freePlay.signedUp(second.userId, 'steve@example.test')
    await h.app.accounts.freePlay.signedUp(paid.userId, 'steve@example.test')
    await ran((await stopped(first)).id, 10 * 60)
    expect((await total(second))?.units).toBeCloseTo(10, 1)
    const secondServer = await stopped(second)
    await ran(secondServer.id, 10 * 60)
    expect((await total(first))?.units).toBeCloseTo(20, 1)
    expect(await sharers(first)).toEqual([first.userId, second.userId].sort())
    await expect(h.app.servers.start(second, secondServer.id, randomUUID())).rejects.toMatchObject({
      code: 'limit_reached',
      message: expect.stringContaining(
        'Your free trial is shared with your other Cubepals account at this email.',
      ),
    })
    expect(await logged(second.userId, 'account.free_linked')).toEqual([
      { actor: 'system:free-play', data: { with: first.userId, confidence: 1 } },
    ])
  }, 90_000)

  test('accounts made before inboxes were kept get theirs, and are linked the same way', async () => {
    const [a, b] = [await owner(), await owner()]
    await h.db.delete(schema.freePlay).where(inArray(schema.freePlay.userId, [a.userId, b.userId]))
    // Every harness account is `<uuid>@example.test`: key them all as one inbox.
    expect(await h.app.accounts.freePlay.fillEmailKeys(() => 'one@example.test')).toBeGreaterThanOrEqual(2)
    expect(await h.app.accounts.freePlay.fillEmailKeys(() => 'one@example.test')).toBe(0)
    expect(await sharers(b)).toContain(a.userId)
  }, 30_000)
})

describe.skipIf(!hasDatabase)('an admin’s hold', () => {
  harness()

  test('stops a free account’s starts and creates, deletes nothing, and a release lifts it', async () => {
    const staff = await admin()
    const free = await owner()
    const server = await stopped(free)
    await h.app.accounts.freePlay.hold(staff, free.userId)
    await expect(h.app.servers.start(free, server.id, randomUUID())).rejects.toMatchObject({
      code: 'restricted',
      message: expect.stringContaining('Your free trial is paused on this account'),
    })
    expect((await h.server(server.id)).lifecycle.status).toBe('stopped')
    expect(await logged(free.userId, 'account.free_held')).toHaveLength(1)

    await h.app.accounts.freePlay.release(staff, free.userId)
    await h.app.servers.start(free, server.id, randomUUID())
    await h.until(server.id, 'running')
    await h.settled(server.id)
  }, 60_000)

  test('leaves paid play alone', async () => {
    const staff = await admin()
    const paid = await owner('plus')
    const server = await stopped(paid)
    await h.app.accounts.freePlay.hold(staff, paid.userId)
    await h.app.servers.start(paid, server.id, randomUUID())
    await h.until(server.id, 'running')
    await h.settled(server.id)
  }, 60_000)
})

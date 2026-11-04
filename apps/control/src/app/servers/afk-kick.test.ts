// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** An idle-kick choice belongs to one server and reaches only that server's next start. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { PAYING } from '../billing/persistence.ts'

describe.skipIf(!hasDatabase)('server idle-kick choices', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })

  test('saving for one server leaves its sibling and the current game alone; reset uses the plan', async () => {
    const owner = await h.user('Idle owner', 'plus')
    const first = await h.create(owner, { name: 'Idle farms' })
    const second = await h.create(owner, { name: 'Idle friends' })
    for (const { id } of [first, second]) {
      await h.until(id, 'running')
      await h.settled(id)
    }
    const runtime = async (id: string) => h.app.specs.desired(h.db, await h.server(id))
    const before = await runtime(first.id)
    const version = (await h.server(first.id)).version
    await h.app.servers.afkKick.set(owner, first.id, 0)
    expect((await h.app.queries.get(owner, first.id)).afkKickMinutes).toBe(0)
    expect((await h.app.queries.get(owner, second.id)).afkKickMinutes).toBeNull()
    expect(h.runtime.machine(first.id)?.spec.env.PLAYER_IDLE_TIMEOUT).toBe('15')
    expect((await runtime(first.id)).spec.env.PLAYER_IDLE_TIMEOUT).toBe('0')
    expect((await runtime(second.id)).spec.env.PLAYER_IDLE_TIMEOUT).toBe('15')
    // A save changes the next boot without drift restarting the running game.
    expect((await runtime(first.id)).driftDigest).toBe(before.driftDigest)
    expect((await runtime(first.id)).digest).not.toBe(before.digest)
    expect((await h.server(first.id)).version).toBe(version + 1)
    await h.app.servers.afkKick.set(owner, first.id, 0)
    expect((await h.server(first.id)).version).toBe(version + 1)
    const audit = await h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, first.id), eq(schema.auditLog.action, 'server.afk_kick_set')))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ subjectType: 'server', data: { minutes: 0 } })
    await h.app.servers.afkKick.set(owner, first.id, 45)
    expect((await runtime(first.id)).spec.env.PLAYER_IDLE_TIMEOUT).toBe('45')
    await h.app.servers.afkKick.set(owner, first.id, null)
    expect((await h.server(first.id)).afkKickMinutes).toBeNull()
    expect((await runtime(first.id)).spec.env.PLAYER_IDLE_TIMEOUT).toBe('15')
  }, 40_000)

  test('only the owner on an eligible plan can change it, and invalid choices write nothing', async () => {
    const owner = await h.user('Private idle', 'plus')
    const stranger = await h.user('Stranger idle', 'plus')
    const server = await h.create(owner, { name: 'Private idle' })
    await expect(h.app.servers.afkKick.set(stranger, server.id, 0)).rejects.toMatchObject({
      name: 'NotFound',
    })
    await expect(
      h.app.servers.afkKick.set({ kind: 'system', reason: 'reconcile' }, server.id, 0),
    ).rejects.toMatchObject({ name: 'NotFound' })
    for (const minutes of [-1, 3, 121, 5.5, Number.NaN])
      await expect(h.app.servers.afkKick.set(owner, server.id, minutes)).rejects.toMatchObject({
        code: 'invalid_choice',
      })
    expect((await h.server(server.id)).afkKickMinutes).toBeNull()
    const free = await h.user('Free idle')
    const trial = await h.create(free, { name: 'Free idle' })
    await expect(h.app.servers.afkKick.set(free, trial.id, 0)).rejects.toMatchObject({ code: 'not_entitled' })
    expect((await h.server(trial.id)).afkKickMinutes).toBeNull()
  }, 30_000)

  test('after a downgrade the owner can reset an earlier choice without choosing a new override', async () => {
    const owner = await h.user('Downgraded idle', 'plus')
    const server = await h.create(owner, { name: 'Downgraded idle' })
    await h.app.servers.afkKick.set(owner, server.id, 0)
    await h.db
      .update(schema.accountStanding)
      .set({ plan: 'free' })
      .where(eq(schema.accountStanding.userId, owner.userId))
    await expect(h.app.servers.afkKick.set(owner, server.id, 30)).rejects.toMatchObject({
      code: 'not_entitled',
    })
    expect((await h.server(server.id)).afkKickMinutes).toBe(0)
    await h.app.servers.afkKick.set(owner, server.id, null)
    expect((await h.server(server.id)).afkKickMinutes).toBeNull()
    expect((await h.app.specs.desired(h.db, await h.server(server.id))).spec.env.PLAYER_IDLE_TIMEOUT).toBe(
      '15',
    )
  }, 30_000)

  test('a paid subscription allows the choice even when the stored account plan is free', async () => {
    const owner = await h.user('Paying idle')
    await h.db.insert(schema.billingSubscriptions).values({
      userId: owner.userId,
      provider: 'local',
      externalCustomerId: randomUUID(),
      externalSubscriptionId: randomUUID(),
      planKey: 'plus',
      status: PAYING[0] ?? '',
    })
    const server = await h.create(owner, { name: 'Paid idle' })
    await h.app.servers.afkKick.set(owner, server.id, 30)
    expect((await h.server(server.id)).afkKickMinutes).toBe(30)
  }, 30_000)

  test('a new server ignores the legacy account choice and uses its plan', async () => {
    const owner = await h.user('Legacy idle', 'plus')
    await h.db
      .update(schema.accountStanding)
      .set({ afkKickMinutes: 0 })
      .where(eq(schema.accountStanding.userId, owner.userId))
    const server = await h.create(owner, { name: 'New idle' })
    expect(server.afkKickMinutes).toBeNull()
    expect((await h.app.specs.desired(h.db, server)).spec.env.PLAYER_IDLE_TIMEOUT).toBe('15')
  }, 30_000)
})

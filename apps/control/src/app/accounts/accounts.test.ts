// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor, UserActor } from '../actor.ts'
import { isAdmin, loadStanding } from './persistence.ts'
import { AccountService } from './service.ts'

// Account standing and admins end to end (§4): what admins do to an account,
// what that does to its servers, and who is an admin at all.
describe.skipIf(!hasDatabase)('accounts', () => {
  let h: Harness
  const admin: Actor = { kind: 'admin', userId: 'set in beforeAll' }
  const listed = `boss-${randomUUID().slice(0, 8)}@example.test`

  beforeAll(async () => {
    h = await startHarness({ adminEmails: [listed] })
    const first = await h.user('First admin')
    await h.db.insert(schema.platformAdmins).values({ userId: first.userId, grantedBy: 'test' })
    Object.assign(admin, { userId: first.userId })
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const running = async (owner?: UserActor) => {
    const person = owner ?? (await h.user())
    const created = await h.create(person)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner: person, id: created.id }
  }
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code?: string; name: string }) => error.code ?? error.name,
    )
  const history = async (userId: string) =>
    (
      await h.db
        .select({ action: schema.auditLog.action, actor: schema.auditLog.actor })
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.subjectType, 'account'), eq(schema.auditLog.subjectId, userId)))
    ).map((row) => `${row.actor} ${row.action}`)

  test('suspension stops what the account runs and denies it starting again, until reinstated', async () => {
    const { owner, id } = await running()
    await h.app.accounts.suspend(admin, owner.userId, 'chargeback')
    const stopped = await h.until(id, 'stopped')
    expect(stopped.lifecycle.stopReason).toBe('policy')
    expect(await loadStanding(h.db, owner.userId)).toMatchObject({
      status: 'suspended',
      reason: 'chargeback',
    })
    expect(await refusal(h.app.servers.start(owner, id, randomUUID()))).toBe('account_suspended')

    await h.app.accounts.reinstate(admin, owner.userId)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    expect(await history(owner.userId)).toEqual([
      `admin:${admin.kind === 'admin' ? admin.userId : ''} account.suspended`,
      `admin:${admin.kind === 'admin' ? admin.userId : ''} account.reinstated`,
    ])
  }, 30_000)

  test('the sweep stops a suspended account’s server that came up after the suspension', async () => {
    const { owner, id } = await running()
    // Suspended by something that didn't stop it: a server mid-way through other work.
    await h.db
      .update(schema.accountStanding)
      .set({ status: 'suspended', reason: 'abuse' })
      .where(eq(schema.accountStanding.userId, owner.userId))
    expect(await h.app.accounts.enforce()).toMatchObject({ stopped: 1 })
    expect((await h.until(id, 'stopped')).lifecycle.stopReason).toBe('policy')
    await h.settled(id)
    expect(await h.app.accounts.enforce()).toMatchObject({ stopped: 0 })
  }, 30_000)

  test('the sweep leaves a size the plan sold before, and stops one it never sold', async () => {
    const { id } = await running()
    // As a server made when free included 4 GB is: on a size the plan no longer offers.
    await h.db
      .update(schema.minecraftServers)
      .set({ memoryTier: '4g' })
      .where(eq(schema.minecraftServers.id, id))
    expect(await h.app.accounts.enforce()).toMatchObject({ stopped: 0 })
    expect((await h.server(id)).lifecycle.status).toBe('running')

    // A size free never sold is another matter: that one stops, as a downgrade's does.
    await h.db
      .update(schema.minecraftServers)
      .set({ memoryTier: '8g' })
      .where(eq(schema.minecraftServers.id, id))
    expect(await h.app.accounts.enforce()).toMatchObject({ stopped: 1 })
    expect((await h.until(id, 'stopped')).lifecycle.stopReason).toBe('entitlement')
    await h.settled(id)
  }, 30_000)

  test('termination closes every server, the trash too, and purges them', async () => {
    const owner = await h.user()
    const trashed = await running(owner)
    await h.app.servers.deleteServer(owner, trashed.id, 'Test server')
    await h.until(trashed.id, 'deleted')
    await h.settled(trashed.id)
    const live = await running(owner)

    await h.app.accounts.terminate(admin, owner.userId, 'fraud')
    for (const id of [live.id, trashed.id]) {
      const closed = await h.until(id, 'deleted')
      expect(closed.purgeAfter?.getTime()).toBeLessThanOrEqual(Date.now())
      await h.settled(id)
    }
    await h.app.schedules.purgeSweep()
    for (const id of [live.id, trashed.id]) await h.until(id, 'purged', 20_000)
    expect(await refusal(h.app.accounts.reinstate(admin, owner.userId))).toBe('invalid_transition')
    expect(
      await refusal(
        h.app.servers.createMinecraftServer(owner, {
          idempotencyKey: randomUUID(),
          name: 'Again',
          playStyle: 'survival',
          partySize: '5',
          regionKey: 'local',
        }),
      ),
    ).toBe('account_suspended')
  }, 60_000)

  test('restrictions, plans and limits change what the account may do', async () => {
    const { owner, id } = await running()
    await h.app.accounts.setRestrictions(admin, owner.userId, { consoleCommands: true })
    expect(await refusal(h.app.console.run(owner, id, 'say hi'))).toBe('restricted')
    await h.app.accounts.setRestrictions(admin, owner.userId, {})
    expect((await loadStanding(h.db, owner.userId)).restrictions).toEqual({})

    // Free allows one server; a limit of two lets a second in.
    const second = () =>
      h.app.servers.createMinecraftServer(owner, {
        idempotencyKey: randomUUID(),
        name: 'Second',
        playStyle: 'survival',
        partySize: '5',
        regionKey: 'local',
      })
    expect(await refusal(second())).toBe('limit_reached')
    await h.app.accounts.setLimits(admin, owner.userId, { maxServers: 2, maxRunning: 2 })
    const made = await second()
    await h.until(made.id, 'running')
    await h.settled(made.id)

    await h.app.accounts.setPlan(admin, owner.userId, 'plus')
    expect((await loadStanding(h.db, owner.userId)).plan).toBe('plus')
    expect(await refusal(h.app.accounts.setPlan(admin, owner.userId, 'platinum'))).toBe('invalid_choice')
    expect(
      await refusal(h.app.accounts.setLimits(admin, owner.userId, { maxServers: -1, maxRunning: null })),
    ).toBe('invalid_choice')
  }, 40_000)

  test('where an account came from is kept once, in its first week, and never overwritten', async () => {
    const sourceOf = async (userId: string) =>
      (
        await h.db
          .select({ source: schema.accountStanding.signupSource })
          .from(schema.accountStanding)
          .where(eq(schema.accountStanding.userId, userId))
      )[0]?.source
    const fresh = await h.user()
    await loadStanding(h.db, fresh.userId)
    await h.app.accounts.recordSource(fresh, 'reddit')
    await h.app.accounts.recordSource(fresh, 'discord')
    expect(await sourceOf(fresh.userId)).toBe('reddit')

    // A link followed long after sign-up is a return visit, not where the account started.
    const old = await h.user()
    await loadStanding(h.db, old.userId)
    await h.db
      .update(schema.accountStanding)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(schema.accountStanding.userId, old.userId))
    await h.app.accounts.recordSource(old, 'reddit')
    expect(await sourceOf(old.userId)).toBeNull()
  })

  test('only admins change standing; the last admin can’t be removed', async () => {
    const someone = await h.user()
    const other = await h.user()
    expect(await refusal(h.app.accounts.suspend(someone, other.userId, 'no reason'))).toBe('NotFound')
    expect(await refusal(h.app.accountQueries.list(someone, { search: '', offset: 0, limit: 10 }))).toBe(
      'NotFound',
    )
    expect(await refusal(h.app.accounts.suspend(admin, randomUUID(), 'nobody'))).toBe('NotFound')

    await h.app.accounts.grantAdmin(admin, someone.userId)
    expect(await isAdmin(h.db, someone.userId)).toBe(true)
    await h.app.accounts.revokeAdmin(admin, someone.userId)
    expect(await isAdmin(h.db, someone.userId)).toBe(false)
    if (admin.kind !== 'admin') throw new Error('admin')
    const admins = await h.db.select().from(schema.platformAdmins)
    for (const row of admins)
      if (row.userId !== admin.userId)
        await h.db.delete(schema.platformAdmins).where(eq(schema.platformAdmins.userId, row.userId))
    expect(await refusal(h.app.accounts.revokeAdmin(admin, admin.userId))).toBe('invalid_choice')

    const me = await h.app.accountQueries.me({ kind: 'user', userId: admin.userId })
    expect(me).toMatchObject({ admin: true, standing: { status: 'active', plan: 'free' } })
    const found = await h.app.accountQueries.list(admin, { search: 'First admin', offset: 0, limit: 10 })
    expect(found.accounts.map((a) => a.userId)).toContain(admin.userId)
    const detail = await h.app.accountQueries.get(admin, someone.userId)
    expect(detail.history.map((e) => e.action)).toEqual(['account.admin_revoked', 'account.admin_granted'])
  }, 30_000)

  test('without billing, plans are the operator’s: checkout says so, and the overview agrees', async () => {
    const owner = await h.user()
    expect(await refusal(h.app.billing.startCheckout(owner, 'plus'))).toBe('deployment_unsupported')
    const overview = await h.app.accountQueries.overview(owner)
    expect(overview.features.find((f) => f.feature === 'billing')).toMatchObject({
      available: false,
      code: 'deployment_unsupported',
    })
    await h.app.accounts.setPlan(admin, owner.userId, 'plus')
    expect((await h.app.accountQueries.overview(owner)).plan).toEqual({ key: 'plus', billed: null })
  })

  test('configured admins are admins once their email is confirmed, and stop being when unlisted', async () => {
    const id = randomUUID()
    await h.db.insert(schema.users).values({ id, name: 'Boss', email: listed, emailVerified: false })
    await h.app.accounts.bootstrapAdmins()
    expect(await isAdmin(h.db, id)).toBe(false)

    await h.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, id))
    await h.app.accounts.configuredAdmin({ id, email: listed.toUpperCase(), emailVerified: true })
    expect(await isAdmin(h.db, id)).toBe(true)

    // A deployment that no longer lists them.
    await new AccountService({
      db: h.db,
      servers: h.app.servers,
      jobs: h.jobs,
      mailer: h.mail,
      webOrigin: 'http://web.test',
      configured: { admins: [], signupCap: true },
    }).bootstrapAdmins()
    expect(await isAdmin(h.db, id)).toBe(false)
    await h.app.accounts.bootstrapAdmins()
    expect(await isAdmin(h.db, id)).toBe(true)
  })
})

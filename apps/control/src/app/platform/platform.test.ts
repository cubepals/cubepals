import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { PlatformControlsView, StuckWorkView } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor, UserActor } from '../actor.ts'
import { pickControls } from './controls.ts'

// Running the platform (§4 PlatformControls, §9 blocked keys and purges, §15.3 a stale
// catalog): kill switches and caps, work that only an admin can move, the alerts that say so,
// and the platform-wide audit log. Operations get two seconds per attempt here, so an attempt
// that hangs fails its job for good within a test.
describe.skipIf(!hasDatabase)('platform administration', () => {
  let h: Harness
  let admin: Extract<Actor, { kind: 'admin' }>
  let adminEmail: string

  beforeAll(async () => {
    h = await startHarness({ operationDeadlineSeconds: 2, serverCeiling: 45, controls: {} })
    const person = await h.user('Admin')
    await h.db.insert(schema.platformAdmins).values({ userId: person.userId, grantedBy: 'test' })
    admin = { kind: 'admin', userId: person.userId }
    adminEmail = `${person.userId}@example.test`
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code?: string; name: string }) => error.code ?? error.name,
    )
  const controlsOf = (view: PlatformControlsView) => pickControls(view)
  const running = async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id }
  }
  const eventually = async <T>(read: () => Promise<T>, want: (value: T) => boolean, what: string) => {
    const deadline = Date.now() + 25_000
    for (;;) {
      const value = await read()
      if (want(value)) return value
      if (Date.now() > deadline) throw new Error(`${what} never happened: ${JSON.stringify(value)}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  const blockedOn = (serverId: string) =>
    eventually(
      () => h.app.stuck.list(admin),
      (work: StuckWorkView) => work.blocked.some((b) => b.serverId === serverId),
      'the stop blocking its server',
    ).then((work) => work.blocked.filter((b) => b.serverId === serverId))
  /** A stop whose provider call never answers, and an access change queued behind it. */
  const hungStop = async (owner: UserActor, id: string) => {
    const release = h.runtime.holdStops(3)
    await h.app.servers.stop(owner, id, randomUUID())
    await h.app.access.setWhitelistEnabled(owner, id, true)
    return release
  }

  test('only admins change the kill switches and caps, the policy obeys at once, and each change is audited', async () => {
    const owner = await h.user()
    expect(await refusal(h.app.platform.view(owner))).toBe('NotFound')
    const before = await h.app.platform.view(admin)
    expect(before).toMatchObject({
      provisioningEnabled: true,
      startsEnabled: true,
      maxServers: 30,
      maxRunningServers: 10,
      usage: { servers: expect.any(Number), running: expect.any(Number) },
    })

    await h.app.platform.set(admin, {
      ...controlsOf(before),
      provisioningEnabled: false,
      maxRunningServers: 5,
    })
    expect(await refusal(h.create(owner))).toBe('platform_paused')
    const after = await h.app.platform.view(admin)
    expect(after).toMatchObject({
      provisioningEnabled: false,
      maxRunningServers: 5,
      updatedBy: `admin:${admin.userId}`,
    })
    const [audit] = await h.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'platform.controls_changed'))
    expect(audit).toMatchObject({
      actor: `admin:${admin.userId}`,
      data: {
        provisioningEnabled: { from: true, to: false },
        maxRunningServers: { from: 10, to: 5 },
      },
    })
    expect(await refusal(h.app.platform.set(owner, controlsOf(before)))).toBe('NotFound')

    await h.app.platform.set(admin, controlsOf(before))
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
  }, 30_000)

  test('the servers cap stays within what the provider’s machine limit holds (§19.12)', async () => {
    const view = await h.app.platform.view(admin)
    expect(view.serverCeiling).toBe(45)
    const refused = await h.app.platform.set(admin, { ...controlsOf(view), maxServers: 46 }).then(
      () => null,
      (error: { code?: string; message: string }) => error,
    )
    expect(refused).toMatchObject({
      code: 'invalid_choice',
      message: expect.stringContaining('holds this deployment to 45 servers'),
    })
    await h.app.platform.set(admin, { ...controlsOf(view), maxServers: 45 })
    expect((await h.app.platform.view(admin)).maxServers).toBe(45)
    await h.app.platform.set(admin, controlsOf(view))
  })

  test('a stop whose attempts hang blocks its server until an admin retries it', async () => {
    const { owner, id } = await running()
    const release = await hungStop(owner, id)
    const [blocked] = await blockedOn(id)
    expect(blocked).toMatchObject({
      kind: 'stop',
      status: 'running',
      error: expect.stringContaining('exceeded'),
      waiting: 1,
    })
    expect((await h.app.alerts.active(admin)).map((a) => a.key)).toContain('blocked_operations')
    expect(
      await refusal(h.app.stuck.retry({ kind: 'user', userId: owner.userId }, blocked?.operationId ?? '')),
    ).toBe('NotFound')

    // The next attempt answers: the stop finishes, and the access change behind it runs.
    await h.app.stuck.retry(admin, blocked?.operationId ?? '')
    await h.until(id, 'stopped')
    const operations = await h.settled(id)
    expect(operations.find((o) => o.id === blocked?.operationId)?.status).toBe('succeeded')
    expect(operations.filter((o) => o.kind === 'access_sync').at(-1)?.status).toBe('succeeded')
    expect((await h.app.stuck.list(admin)).blocked.filter((b) => b.serverId === id)).toEqual([])
    const [audit] = await h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'operation.retried'), eq(schema.auditLog.subjectId, id)))
    expect(audit?.data).toMatchObject({ operationId: blocked?.operationId, kind: 'stop' })
    release()
  }, 60_000)

  test('discarding a blocked operation fails it as the runner would, and frees the queue', async () => {
    const { owner, id } = await running()
    const release = await hungStop(owner, id)
    const [blocked] = await blockedOn(id)
    await h.app.stuck.discard(admin, blocked?.operationId ?? '')

    const server = await h.until(id, 'failed')
    expect(server.lifecycle.failure).toMatchObject({ during: 'stopping', operationId: blocked?.operationId })
    // Given up on, the stop is forced: the held provider call no longer decides anything.
    expect(h.runtime.machine(id)?.state).toBe('stopped')
    const operations = await h.settled(id)
    const discarded = operations.find((o) => o.id === blocked?.operationId)
    // The owner reads that it got stuck and was stopped; admins read what the job said.
    expect(discarded).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('It got stuck'),
      detail: expect.stringContaining('discarded by an admin'),
    })
    expect(operations.filter((o) => o.kind === 'access_sync').at(-1)?.status).not.toBe('queued')
    expect((await h.app.stuck.list(admin)).blocked.filter((b) => b.serverId === id)).toEqual([])
    release()
  }, 60_000)

  test('a failing purge retries after each failure, alerts admins once, and clears when it converges', async () => {
    const { owner, id } = await running()
    const server = await h.server(id)
    await h.app.servers.deleteServer(owner, id, server.name)
    await h.settled(id)
    h.runtime.failDestroys('the volume is busy')
    await h.db
      .update(schema.minecraftServers)
      .set({ purgeAfter: sql`now() - interval '2 hours'` })
      .where(eq(schema.minecraftServers.id, id))

    await h.app.schedules.purgeSweep()
    await h.settled(id, 20_000)
    const overdue = await h.app.stuck.list(admin)
    expect(overdue.overduePurges.find((p) => p.serverId === id)).toMatchObject({
      failedAttempts: 1,
      lastError: 'the volume is busy',
    })

    const mailed = h.mail.to(adminEmail).length
    expect((await h.app.alerts.sweep()).raised).toContain('purge_overdue')
    const alert = h.mail.to(adminEmail).at(-1)
    expect(alert?.subject).toContain('1 deleted server is past its purge date')
    expect(alert?.text).toContain('http://localhost:3000/admin/operations')
    // Raised once: the next sweep doesn't tell anyone again.
    expect((await h.app.alerts.sweep()).raised).not.toContain('purge_overdue')
    expect(h.mail.to(adminEmail).length).toBe(mailed + 1)

    // The next sweep tries again, once for the failure it saw.
    await h.app.schedules.purgeSweep()
    await h.settled(id, 20_000)
    await h.app.schedules.purgeSweep()
    await h.settled(id, 20_000)
    expect((await h.app.stuck.list(admin)).overduePurges.find((p) => p.serverId === id)?.failedAttempts).toBe(
      3,
    )

    h.runtime.failDestroys(null)
    await h.app.schedules.purgeSweep()
    await h.until(id, 'purged', 20_000)
    await h.settled(id)
    expect((await h.app.alerts.sweep()).cleared).toContain('purge_overdue')
    expect((await h.app.alerts.active(admin)).map((a) => a.key)).not.toContain('purge_overdue')
  }, 90_000)

  test('a catalog that stops answering is an alert until an admin refreshes it', async () => {
    const project = `stale-${randomUUID().slice(0, 6)}`
    h.catalog.publish(
      {
        projectId: project,
        slug: project,
        name: 'Stale',
        summary: '',
        iconUrl: null,
        environments: [],
        downloads: 1,
      },
      [],
    )
    await h.app.listings.trustProject(admin, project, null)
    await h.db
      .insert(schema.catalogRefreshes)
      .values({ catalog: 'modrinth', refreshedAt: sql`now() - interval '7 hours'`, failedAt: null })
      .onConflictDoUpdate({
        target: schema.catalogRefreshes.catalog,
        set: { refreshedAt: sql`now() - interval '7 hours'`, failedAt: null },
      })
    // Seven hours old with nothing asked, as after a night the platform was off: no alert, and a
    // worker starting now refreshes it first.
    expect((await h.app.alerts.sweep()).raised).not.toContain('catalog_stale')
    expect(await h.app.catalog.missedRefresh()).toBe(true)
    // Asked, and no answer: that is the alert.
    h.catalog.outage(true)
    await expect(h.app.catalog.refresh()).rejects.toThrow()
    h.catalog.outage(false)
    expect((await h.app.alerts.sweep()).raised).toContain('catalog_stale')
    expect(h.mail.to(adminEmail).at(-1)?.subject).toContain("mod catalog hasn't answered")
    // Someone planning mods writes the cache, but that is no refresh: the alert stays.
    await h.app.catalog.recordObserved({ projects: new Map([[project, 'approved']]), versions: new Map() })
    expect((await h.app.alerts.sweep()).cleared).not.toContain('catalog_stale')

    h.catalog.outage(true)
    expect(await refusal(h.app.platform.refreshCatalog(admin))).toBe('catalog_unavailable')
    h.catalog.outage(false)
    expect(await h.app.platform.refreshCatalog(admin)).toEqual({ changed: 0 })
    expect((await h.app.platform.view(admin)).catalogHeardAt).not.toBeNull()
    expect((await h.app.alerts.sweep()).cleared).toContain('catalog_stale')
  }, 30_000)

  test('an account whose worlds outgrow what its plan covers is an alert, and nothing is done to it', async () => {
    const GB = 2 ** 30
    const payer = await h.user('Hoarder', 'plus')
    const first = await h.create(payer, { name: 'Big One' })
    const second = await h.create(payer, { name: 'Big Two' })
    for (const server of [first, second]) {
      await h.until(server.id, 'running')
      await h.settled(server.id)
    }
    const measure = (id: string, bytes: number) =>
      h.db
        .update(schema.serverRuntimes)
        .set({ diskUsedBytes: bytes })
        .where(eq(schema.serverRuntimes.serverId, id))
    // 9 GB of worlds is within what Plus's price covers.
    await measure(first.id, 4 * GB)
    await measure(second.id, 5 * GB)
    expect((await h.app.alerts.sweep()).raised).not.toContain('worlds_outgrow_plan')
    // 11 GB is past it: the owner of Blockly is told, and the player's servers carry on.
    await measure(second.id, 7 * GB)
    expect((await h.app.alerts.sweep()).raised).toContain('worlds_outgrow_plan')
    expect(h.mail.to(adminEmail).at(-1)?.subject).toContain(
      '1 account keeps more world data than its plan covers',
    )
    expect((await h.server(second.id)).lifecycle.status).toBe('running')
    // A world that rests no longer holds a disk, and no longer counts.
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'stored' })
      .where(eq(schema.minecraftServers.id, second.id))
    expect((await h.app.alerts.sweep()).cleared).toContain('worlds_outgrow_plan')
    await h.db
      .update(schema.minecraftServers)
      .set({ status: 'running' })
      .where(eq(schema.minecraftServers.id, second.id))
    await measure(second.id, 1 * GB)
  }, 60_000)

  test('the audit log reads newest first, by action family, person or subject, a page at a time', async () => {
    const { owner, id } = await running()
    await h.app.console.run(owner, id, 'say one')
    await h.app.console.run(owner, id, 'say two')
    for (let i = 0; i < 51; i++) await h.app.console.run(admin, id, `say admin ${i}`)

    const mine = await h.app.audit.search(admin, {
      action: 'console.',
      who: `${owner.userId}@example.test`,
      subject: '',
      cursor: null,
    })
    expect(mine.entries.map((e) => e.data.command)).toEqual(['say two', 'say one'])
    expect(mine.entries[0]).toMatchObject({
      actor: `user:${owner.userId}`,
      actorEmail: `${owner.userId}@example.test`,
      subjectType: 'server',
      subjectId: id,
      subjectName: (await h.server(id)).name,
    })
    expect(mine.next).toBeNull()

    const first = await h.app.audit.search(admin, {
      action: 'console.command',
      who: adminEmail,
      subject: id,
      cursor: null,
    })
    expect(first.entries).toHaveLength(50)
    expect(first.entries[0]?.data.command).toBe('say admin 50')
    const second = await h.app.audit.search(admin, {
      action: 'console.command',
      who: adminEmail,
      subject: id,
      cursor: first.next,
    })
    expect(second.entries.map((e) => e.data.command)).toEqual(['say admin 0'])
    expect(second.next).toBeNull()

    // Older than those pages, the server's own history is there under its family.
    const lifecycle = await h.app.audit.search(admin, {
      action: 'server.',
      who: '',
      subject: id,
      cursor: null,
    })
    expect(lifecycle.entries.map((e) => e.action)).toEqual(['server.created'])
    expect(await refusal(h.app.audit.search(owner, { action: '', who: '', subject: '', cursor: null }))).toBe(
      'NotFound',
    )
  }, 60_000)
})

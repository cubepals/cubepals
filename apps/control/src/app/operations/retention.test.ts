import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

const DAY = 86_400_000

// A Free world nobody has played for a year is deleted, and never without two
// warnings first, each with a way to keep it and a way to download it. It is off until an admin
// turns it on, and when it goes, it goes into the trash like any deletion.
describe.skipIf(!hasDatabase)('retention', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  beforeEach(async () => {
    await h.db.update(schema.platformControls).set({ expiringEnabled: true })
  })

  afterAll(async () => {
    await h.close()
  })

  /** A server nobody has played on for `days`, asleep. */
  const unplayed = async (days: number, plan = 'free', name = 'Steve') => {
    const owner = await h.user(name, plan)
    const server = await h.create(owner, { name: `${name}'s World` })
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(owner, server.id, randomUUID())
    await h.until(server.id, 'stopped')
    await h.settled(server.id)
    await h.db
      .update(schema.minecraftServers)
      .set({ lastActiveAt: new Date(Date.now() - days * DAY) })
      .where(eq(schema.minecraftServers.id, server.id))
    return { owner, id: server.id }
  }
  const mailFor = (id: string) => h.mail.sent.filter((m) => m.text.includes(`/servers/${id}`))
  const sweep = (daysFromNow = 0) => h.app.schedules.retentionSweep(new Date(Date.now() + daysFromNow * DAY))

  test('nothing is warned or deleted until an admin turns it on', async () => {
    await h.db.update(schema.platformControls).set({ expiringEnabled: false })
    const { owner, id } = await unplayed(400, 'free', 'Off')
    expect(await sweep()).toEqual({ warned: 0, deleted: 0 })
    expect(mailFor(id)).toEqual([])
    expect((await h.server(id)).deletedAt).toBeNull()
    expect((await h.app.queries.get(owner, id)).deletesAt).toBeNull()
  }, 30_000)

  test('a month before, then a week before, each once; then into the trash', async () => {
    const { owner, id } = await unplayed(340, 'free', 'Ada')
    // A month out: the first warning, said once however often the sweep runs.
    await sweep()
    await sweep()
    expect(mailFor(id)).toHaveLength(1)
    const first = mailFor(id)[0]
    expect(first?.subject).toMatch(/^We’re keeping Ada's World until /)
    expect(first?.text).toContain('Free worlds are kept for a year after they were last played')
    expect(first?.text).toContain('Keep it')
    expect(first?.text).toContain(`/servers/${id}/backups`)
    expect(first?.html).toContain('<img src="http://localhost:3000/email/kai-hanging.png"')
    // The owner's page says when, with the way to keep it.
    const view = await h.app.queries.get(owner, id)
    expect(view.deletesAt).not.toBeNull()

    // A week out: the second.
    await sweep(20)
    expect(mailFor(id)).toHaveLength(2)
    // Its day comes, but not a week since the last warning: nothing yet.
    await sweep(25)
    expect((await h.server(id)).deletedAt).toBeNull()
    // A week after the last warning, and past its day: it goes, into the trash.
    await sweep(28)
    const gone = await h.server(id)
    expect(gone.lifecycle.status).toBe('deleted')
    expect(gone.purgeAfter).not.toBeNull()
    // Seven days in the trash, where its owner can still bring it back.
    await h.app.servers.undeleteServer(owner, id)
    expect((await h.server(id)).deletedAt).toBeNull()
  }, 60_000)

  test('a sweep that was off, or late, never deletes a world its owner wasn’t warned about', async () => {
    const { id } = await unplayed(400, 'free', 'Late')
    // Long past its day, never warned: warned now, with a full week's notice.
    await sweep()
    expect(mailFor(id)).toHaveLength(1)
    expect((await h.server(id)).deletedAt).toBeNull()
    await sweep(6)
    expect((await h.server(id)).deletedAt).toBeNull()
    await sweep(7)
    expect((await h.server(id)).lifecycle.status).toBe('deleted')
  }, 60_000)

  test('keeping it, or playing on it, starts the year over', async () => {
    const { owner, id } = await unplayed(340, 'free', 'Kept')
    await sweep()
    expect(mailFor(id)).toHaveLength(1)
    await h.app.servers.keepWorld(owner, id)
    expect((await h.app.queries.get(owner, id)).deletesAt).toBeNull()
    // A year of sweeps later... well, a month of them: nothing more is said or done.
    for (const days of [20, 30, 60]) await sweep(days)
    expect(mailFor(id)).toHaveLength(1)
    expect((await h.server(id)).deletedAt).toBeNull()
  }, 60_000)

  test('Plus keeps its worlds for as long as it is Plus', async () => {
    const { id } = await unplayed(800, 'plus', 'Payer')
    await sweep()
    await sweep(60)
    expect(mailFor(id)).toEqual([])
    expect((await h.server(id)).deletedAt).toBeNull()
  }, 30_000)
})

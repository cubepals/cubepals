import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { schema } from '@blockly/db'
import { METER_UNITS } from '../../domain/account/meter.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { UserActor } from '../actor.ts'
import { runUnitsSince } from './persistence.ts'

/**
 * Play measured in units, and spent only as far as the owner allowed (§15.5). A unit is an hour
 * of play, and a large server uses two.
 */
describe.skipIf(!hasDatabase)('metered play', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  /**
   * The moment the play below is counted at: the 15th of next month. A month's play counts from
   * the 1st up to now, so in a month's first days there isn't room behind now for the hours these
   * tests record; the 15th has two weeks of it. Next month's, so that it also comes after anything
   * the harness really runs today: counted at a moment before it began, a run would count backwards.
   */
  const today = new Date()
  const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 15))

  /** A run that happened: one closed interval, on a size, for a number of hours, ended before `at`. */
  const ran = async (serverId: string, tier: string, hours: number, endedHoursAgo = 0) => {
    const stoppedAt = new Date(at.getTime() - endedHoursAgo * 3_600_000)
    await h.db.insert(schema.powerIntervals).values({
      serverId,
      memoryTier: tier,
      startedAt: new Date(stoppedAt.getTime() - hours * 3_600_000),
      stoppedAt,
    })
  }

  /**
   * Its owner starting a server, with the policy deciding at `at`. A start takes no moment of its
   * own, and setting the process's clock instead would move pg-boss's under its polling workers.
   * Null when it starts; otherwise what the owner is told.
   */
  const start = async (owner: UserActor, serverId: string): Promise<string | null> => {
    const policy = h.app.policy
    const check = policy.check.bind(policy)
    const pinned = spyOn(policy, 'check').mockImplementation((tx, accountId, capability, _now, options) =>
      check(tx, accountId, capability, at, options),
    )
    try {
      return await h.app.servers.start(owner, serverId, crypto.randomUUID()).then(
        () => null,
        (error: { message?: string }) => error.message ?? '',
      )
    } finally {
      pinned.mockRestore()
    }
  }

  test('an hour costs what its size costs, not what the clock says', async () => {
    const owner = await h.user('Steve', 'plus')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    // An hour is an hour on 3 and 4 GB, and two on a large server.
    expect([METER_UNITS['3g'], METER_UNITS['4g'], METER_UNITS['8g']]).toEqual([1, 1, 2])

    const since = new Date(at.getTime() - 24 * 3_600_000)
    const before = await runUnitsSince(h.db, owner.userId, since, at)
    await ran(server.id, '3g', 2, 3)
    await ran(server.id, '4g', 2, 5)
    await ran(server.id, '8g', 2, 8)
    const after = await runUnitsSince(h.db, owner.userId, since, at)
    // Six hours of clock, eight hours of play.
    expect(Math.round((after - before) * 10) / 10).toBe(8)
  }, 40_000)

  test('play past the included block is refused until the owner allows it, and only that far', async () => {
    const owner = await h.user('Alex')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(owner, server.id, crypto.randomUUID(), 'user')
    await h.until(server.id, 'stopped')
    await h.settled(server.id)

    // Free includes 20 units, and does not sell more.
    await ran(server.id, '3g', 21, 1)
    const refused = await start(owner, server.id)
    expect(refused).toContain('play time')
    // Free can't allow more; saying so is the whole answer.
    const asked = await h.app.accounts.allowExtraPlay(owner, 50).then(
      () => null,
      (error: { message?: string }) => error.message ?? '',
    )
    expect(asked).toBe('Extra hours aren’t available yet. This month’s hours reset on the 1st.')
  }, 40_000)

  test('the month says something at half, at four fifths and when it runs out, once each', async () => {
    const owner = await h.user('Sam', 'plus')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(owner, server.id, crypto.randomUUID(), 'user')
    await h.until(server.id, 'stopped')
    await h.settled(server.id)
    const sentTo = () => h.mail.sent.filter((m) => m.subject.includes('play')).length

    // Nothing to say at a sixth of the way through Plus's 60 hours.
    await ran(server.id, '3g', 10, 1)
    expect(await h.app.accounts.warnAboutPlay(owner.userId, at)).toBeNull()

    // Half: said once, and not again on the next sweep.
    await ran(server.id, '3g', 20, 1)
    expect(await h.app.accounts.warnAboutPlay(owner.userId, at)).toBe(50)
    const after = sentTo()
    expect(after).toBeGreaterThan(0)
    expect(await h.app.accounts.warnAboutPlay(owner.userId, at)).toBeNull()
    expect(sentTo()).toBe(after)

    // Four fifths, then all of it: each said once, in its own words.
    await ran(server.id, '3g', 18, 1)
    expect(await h.app.accounts.warnAboutPlay(owner.userId, at)).toBe(80)
    await ran(server.id, '3g', 12, 1)
    expect(await h.app.accounts.warnAboutPlay(owner.userId, at)).toBe(100)
    const last = h.mail.sent.at(-1)
    expect(last?.subject).toContain('asleep until the 1st')
    expect(last?.text).toContain('Cubepals only spends what you allow')
  }, 40_000)

  test('on Plus play stops at the block, and nothing past it can be allowed before billing meters it', async () => {
    const owner = await h.user('Robin', 'plus')
    const server = await h.create(owner)
    await h.until(server.id, 'running')
    await h.settled(server.id)
    await h.app.servers.stop(owner, server.id, crypto.randomUUID(), 'user')
    await h.until(server.id, 'stopped')
    await h.settled(server.id)

    // Plus includes 60 hours; 60 spent.
    await ran(server.id, '3g', 60, 1)
    const refused = await start(owner, server.id)
    expect(refused).toBe('You have used this month’s play time. It resets on the 1st.')
    // Extra hours aren't sold until billing meters them: allowing some is refused, and nothing
    // runs that nobody would be billed for, nor anything anybody would be surprised by.
    const asked = await h.app.accounts.allowExtraPlay(owner, 20).then(
      () => null,
      (error: { message?: string }) => error.message ?? '',
    )
    expect(asked).not.toBeNull()
    const again = await start(owner, server.id)
    expect(again).toBe(refused)
  }, 40_000)
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An operator's notice on an account, on a real database: what it may say, that setting and
 * clearing it are audited, that its limit is put on once when due (the running limit at 0 through
 * the account's limits, its running servers stopped), and that clearing it leaves that limit.
 * Saying it in game is `operations/notice-said.test.ts`'s.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HOUR_MS, MINUTE_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { and, eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { AccountNotices } from './notice.ts'

const ADA: Actor = { kind: 'operator', name: 'ada' }
const NOTICE = '&cThis account is under review'

let h: Harness

beforeAll(async () => {
  if (hasDatabase) h = await startHarness()
}, 30_000)

afterAll(async () => {
  await h?.close()
})

const running = async (name: string) => {
  const owner = await h.user(name)
  const server = await h.create(owner, { name })
  await h.until(server.id, 'running')
  await h.settled(server.id)
  return { owner, id: server.id }
}
const audit = (userId: string, action: string) =>
  h.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectId, userId), eq(schema.auditLog.action, action)))

describe.skipIf(!hasDatabase)('an account’s notice', () => {
  test('is held to what a server message may say, and only operators set it', async () => {
    const owner = await h.user('Wordy')
    const notices = h.app.accounts.notices
    for (const text of ['   ', '&c', 'Two\nlines', 'x'.repeat(200)])
      await expect(notices.set(ADA, owner.userId, { text, limitAt: null })).rejects.toBeInstanceOf(AppError)
    await expect(notices.set(owner, owner.userId, { text: 'Mine', limitAt: null })).rejects.toBeInstanceOf(
      NotFound,
    )
    await expect(notices.set(ADA, randomUUID(), { text: 'Nobody', limitAt: null })).rejects.toBeInstanceOf(
      NotFound,
    )
    expect(await notices.get(ADA, owner.userId)).toBeNull()
  })

  test('is set and cleared in the audit log, with who set it', async () => {
    const owner = await h.user('Told')
    const notices = h.app.accounts.notices
    const set = await notices.set(ADA, owner.userId, { text: `  ${NOTICE} `, limitAt: null })
    expect(set).toMatchObject({ text: NOTICE, setBy: 'operator:ada', limitAt: null, limitedAt: null })
    expect(await notices.get(ADA, owner.userId)).toMatchObject({ text: NOTICE })
    expect((await h.app.accountQueries.get(ADA, owner.userId)).notice).toMatchObject({ text: NOTICE })
    const [entry] = await audit(owner.userId, 'account.notice_set')
    expect(entry).toMatchObject({ actor: 'operator:ada', data: { notice: NOTICE, limitAt: null } })
    expect(await notices.clear(ADA, owner.userId)).toMatchObject({ text: NOTICE })
    expect(await notices.get(ADA, owner.userId)).toBeNull()
    expect(await audit(owner.userId, 'account.notice_cleared')).toHaveLength(1)
    // Cleared again, there was none.
    expect(await notices.clear(ADA, owner.userId)).toBeNull()
  })
})

describe.skipIf(!hasDatabase)('an account’s notice’s limit', () => {
  test('limits the account once when its time comes: nothing runs, and what ran is stopped', async () => {
    const { owner, id } = await running('Limited')
    const notices = h.app.accounts.notices
    await h.app.accounts.setLimits(ADA, owner.userId, {
      maxServers: 4,
      maxRunning: null,
      includedUnits: null,
    })
    const limitAt = new Date(Date.now() + HOUR_MS)
    await notices.set(ADA, owner.userId, { text: NOTICE, limitAt })
    // Before its time, nothing.
    expect(await notices.applyDue(new Date(limitAt.getTime() - MINUTE_MS))).toBe(0)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    expect(await notices.applyDue(limitAt)).toBe(1)
    await h.until(id, 'stopped')
    const detail = await h.app.accountQueries.get(ADA, owner.userId)
    expect(detail.standing.limitOverrides).toEqual({ maxServers: 4, maxRunning: 0 })
    expect(detail.notice?.limitedAt).toEqual(limitAt)
    const [limited] = await audit(owner.userId, 'account.notice_limited')
    expect(limited).toMatchObject({
      actor: 'operator:ada',
      data: { limitAt: limitAt.toISOString() },
    })
    // The limit is the operator's, as `limits` would have set it.
    expect(await audit(owner.userId, 'account.limits_set')).toHaveLength(2)
    // Once.
    expect(await notices.applyDue(new Date(limitAt.getTime() + HOUR_MS))).toBe(0)
    expect(await audit(owner.userId, 'account.notice_limited')).toHaveLength(1)
    // Clearing the notice leaves the limit; lifting it is `limits`.
    expect((await notices.clear(ADA, owner.userId))?.limitedAt).toEqual(limitAt)
    const after = await h.app.accountQueries.get(ADA, owner.userId)
    expect(after.standing.limitOverrides).toEqual({ maxServers: 4, maxRunning: 0 })
  }, 60_000)

  test('a notice replaced or cleared since it was read limits nothing', async () => {
    const notices = h.app.accounts.notices
    for (const change of ['replaced later', 'replaced telling', 'cleared'] as const) {
      const { owner, id } = await running(`Changed ${change}`)
      const now = new Date()
      const old = await notices.set(ADA, owner.userId, {
        text: NOTICE,
        limitAt: new Date(now.getTime() - MINUTE_MS),
      })
      if (change === 'cleared') await notices.clear(ADA, owner.userId)
      else
        await notices.set(ADA, owner.userId, {
          text: 'Something else',
          limitAt: change === 'replaced later' ? new Date(now.getTime() + HOUR_MS) : null,
        })
      expect(await notices.limitIfStillDue(owner.userId, old.setAt, now)).toBe(false)
      const detail = await h.app.accountQueries.get(ADA, owner.userId)
      expect(detail.standing.limitOverrides).toEqual({})
      expect(detail.notice?.limitedAt ?? null).toBeNull()
      expect((await h.server(id)).lifecycle.status).toBe('running')
      expect(await audit(owner.userId, 'account.notice_limited')).toEqual([])
    }
  }, 60_000)

  test('a limit claimed is saved with its claim, even when stopping what runs fails', async () => {
    const { owner, id } = await running('Unstoppable')
    const accounts = h.app.accounts
    const notices = new AccountNotices({
      db: h.db,
      accounts: {
        setLimits: (...args: Parameters<typeof accounts.setLimits>) => accounts.setLimits(...args),
        stopServersOf: async () => {
          throw new Error('The provider is down')
        },
      },
    })
    const now = new Date()
    const set = await notices.set(ADA, owner.userId, {
      text: NOTICE,
      limitAt: new Date(now.getTime() - MINUTE_MS),
    })
    expect(await notices.limitIfStillDue(owner.userId, set.setAt, now)).toBe(true)
    const detail = await h.app.accountQueries.get(ADA, owner.userId)
    expect(detail.standing.limitOverrides).toEqual({ maxRunning: 0 })
    expect(detail.notice?.limitedAt).toEqual(now)
    expect(await audit(owner.userId, 'account.limits_set')).toHaveLength(1)
    expect(await audit(owner.userId, 'account.notice_limited')).toHaveLength(1)
    expect((await h.server(id)).lifecycle.status).toBe('running')
    // What still runs past its running limit, the standing sweep stops.
    await h.app.accounts.enforce()
    await h.until(id, 'stopped')
  }, 60_000)
})

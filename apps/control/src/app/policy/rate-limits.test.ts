import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import { PER_MINUTE } from '../../domain/policy/policy.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

// Rate limits on the console and on access changes (§15.1, §15.5): counted from the account's
// own audited actions in the last minute, through the services people call.
describe.skipIf(!hasDatabase)('rate limits', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code?: string }) => error.code ?? 'error',
    )
  const running = async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    return { owner, id: created.id }
  }
  /** Moves an actor's audited actions out of the last minute. */
  const aMinuteLater = (actor: string) =>
    h.db
      .update(schema.auditLog)
      .set({ at: sql`${schema.auditLog.at} - interval '2 minutes'` })
      .where(eq(schema.auditLog.actor, actor))

  test('the console takes a keyboard’s pace of commands, then asks for a minute', async () => {
    const { owner, id } = await running()
    for (let i = 0; i < PER_MINUTE.console_command; i++) await h.app.console.run(owner, id, `say ${i}`)
    expect(await refusal(h.app.console.run(owner, id, 'say one too many'))).toBe('rate_limited')

    // Admins are not the owner: their commands are audited and not counted against them.
    const admin: Actor = { kind: 'admin', userId: (await h.user('Admin')).userId }
    expect(await refusal(h.app.console.run(admin, id, 'say admin here'))).toBeNull()

    await aMinuteLater(`user:${owner.userId}`)
    expect(await refusal(h.app.console.run(owner, id, 'say back again'))).toBeNull()
  }, 60_000)

  test('access changes are counted the same way, per account', async () => {
    const { owner, id } = await running()
    for (let i = 0; i < PER_MINUTE.manage_access; i++)
      await h.app.access.setWhitelistEnabled(owner, id, i % 2 === 0)
    expect(await refusal(h.app.access.setWhitelistEnabled(owner, id, true))).toBe('rate_limited')

    // Someone else's limit is their own.
    const other = await running()
    expect(await refusal(h.app.access.setWhitelistEnabled(other.owner, other.id, true))).toBeNull()

    await aMinuteLater(`user:${owner.userId}`)
    expect(await refusal(h.app.access.setWhitelistEnabled(owner, id, true))).toBeNull()
    await h.settled(id, 30_000)
  }, 90_000)
})

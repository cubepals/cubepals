/**
 * Where an account came from, by campaign: the UTM tags past a link's source, which the funnel
 * counts sign-ups by. The source alone, kept once and only in
 * the first week, is `accounts.test.ts`'s.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { loadStanding } from './persistence.ts'

describe.skipIf(!hasDatabase)('where an account came from, by campaign', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const kept = async (userId: string) =>
    (await h.db.select().from(schema.accountStanding).where(eq(schema.accountStanding.userId, userId)))[0]

  test('a link’s medium, campaign, content and term come with its source, and stay with it', async () => {
    const fresh = await h.user()
    await loadStanding(h.db, fresh.userId)
    await h.app.accounts.recordSource(fresh, 'tiktok', {
      medium: 'paid',
      campaign: 'spring',
      content: 'clip-2',
      term: null,
    })
    await h.app.accounts.recordSource(fresh, 'discord', {
      medium: 'chat',
      campaign: 'other',
      content: null,
      term: null,
    })
    expect(await kept(fresh.userId)).toMatchObject({
      signupSource: 'tiktok',
      signupMedium: 'paid',
      signupCampaign: 'spring',
      signupContent: 'clip-2',
      signupTerm: null,
    })
  })

  test('a link that named only its source keeps no tags', async () => {
    const fresh = await h.user()
    await loadStanding(h.db, fresh.userId)
    await h.app.accounts.recordSource(fresh, 'reddit')
    expect(await kept(fresh.userId)).toMatchObject({
      signupSource: 'reddit',
      signupMedium: null,
      signupCampaign: null,
    })
  })
})

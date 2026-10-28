// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One rule for a server's public page and everything that hangs off it, and one for its
 * invitation and everything reached through it (`reachable.ts`), on a real database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor, UserActor } from '../actor.ts'
import { saveEligibility } from './persistence.ts'

describe.skipIf(!hasDatabase)('who can reach a server', () => {
  let h: Harness
  let admin: Actor

  beforeAll(async () => {
    h = await startHarness()
    admin = { kind: 'admin', userId: (await h.user('Staff')).userId }
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const published = async () => {
    const owner = await h.user('Owner')
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.listings.setPublic(owner, created.id, true)
    return { owner, id: created.id, slug: created.slug, code: created.inviteCode }
  }
  const stranger = async (): Promise<UserActor> => ({
    kind: 'user',
    userId: (await h.user('Alex Stone')).userId,
  })
  const refusal = (work: Promise<unknown>) =>
    work.then(
      () => 'none',
      (error: { code?: string; name?: string }) => error.code ?? error.name,
    )
  const outOfDirectory = (id: string, code: string) =>
    saveEligibility(h.db, id, { eligible: false, reasons: [{ code }], revisionId: null, at: new Date() })

  test('a restricted account’s page is gone for everyone but its owner, with all that hangs off it', async () => {
    const { owner, id, slug } = await published()
    const alex = await stranger()
    expect(await h.app.sharingQueries.page(slug, null)).not.toBeNull()
    expect(await refusal(h.app.guestbook.notes(alex, id))).toBe('none')

    await h.app.accounts.setRestrictions(admin, owner.userId, { publicListing: true })
    await h.app.listings.reevaluate([id])
    expect(await h.app.sharingQueries.page(slug, null)).toBeNull()
    expect(await h.app.sharingQueries.page(slug, alex, { reactions: true })).toBeNull()
    expect(await h.app.sharingQueries.reach({ slug }, alex)).toBeNull()
    expect(await refusal(h.app.guestbook.notes(alex, id))).toBe('NotFound')
    expect(await refusal(h.app.guestbook.addNote(alex, id, 'Hello there'))).toBe('NotFound')
    expect(await refusal(h.app.guestbook.star(alex, id, true))).toBe('NotFound')
    expect(await refusal(h.app.listings.report(alex, id, 'Not nice'))).toBe('NotFound')
    // Its owner still sees what they would publish.
    expect(await h.app.sharingQueries.page(slug, owner)).toMatchObject({ preview: true })
  }, 60_000)

  test('an offensive name keeps the page closed; anything else out of the directory keeps it open', async () => {
    const { id, slug } = await published()
    const alex = await stranger()
    await outOfDirectory(id, 'offensive_name')
    expect(await h.app.sharingQueries.page(slug, null)).toBeNull()
    expect(await refusal(h.app.listings.report(alex, id, 'Not nice'))).toBe('NotFound')

    // Mods Blockly hasn't checked keep it out of Browse only: the page opens by link, and a
    // stranger who opened it can report it.
    await outOfDirectory(id, 'untrusted_mods')
    expect(await h.app.sharingQueries.page(slug, null)).not.toBeNull()
    expect(await refusal(h.app.guestbook.notes(alex, id))).toBe('none')
    expect(await refusal(h.app.listings.report(alex, id, 'Not nice'))).toBe('none')
  }, 60_000)

  test('a server taken down, or whose owner is suspended, can’t be copied through its invitation', async () => {
    const { owner, id, slug, code } = await published()
    const alex = await stranger()
    const copy = () => h.app.queries.setupPreview(alex, { kind: 'server', slug, invite: code })
    expect(await refusal(copy())).toBe('none')

    await h.app.listings.moderate(admin, id, 'remove', 'Not for here')
    expect(await refusal(copy())).toBe('NotFound')
    expect(await h.app.sharingQueries.invite(code)).toBeNull()
    // Its owner can still make another like it.
    expect(await refusal(h.app.queries.setupPreview(owner, { kind: 'server', slug, invite: code }))).toBe(
      'none',
    )

    await h.app.listings.moderate(admin, id, 'restore', '')
    expect(await refusal(copy())).toBe('none')
    await h.app.accounts.suspend(admin, owner.userId, 'A test')
    expect(await refusal(copy())).toBe('NotFound')
    expect(await refusal(h.app.sharing.joinThroughInvite(code, 'Friend'))).toBe('NotFound')
  }, 60_000)
})

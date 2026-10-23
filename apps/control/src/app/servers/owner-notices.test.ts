// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Owners told when Cubepals changes their server, end to end: an operator's or another admin's new
 * address and unlisting each send one notice, from the notices' own sender, once stored; the
 * owner's own changes send none; and a notice for an older change can be sent again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor } from '../actor.ts'

const operator: Actor = { kind: 'operator', name: 'ada' }

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string; message: string }) => `${error.code}: ${error.message}`,
  )

describe.skipIf(!hasDatabase)('owner notices', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  const emailOf = async (userId: string) => (await h.app.accountQueries.get(operator, userId)).email
  /** What went out from the notices' own sender, to `to`. */
  const noticesTo = (to: string) => h.mail.to(to).filter((m) => m.notice)

  test('an operator’s new address tells the owner once, after it is stored', async () => {
    const owner = await h.user('Maple')
    const made = await h.create(owner, { name: 'Maple Hollow', slug: 'maple-old' })
    await h.app.notices.changeAddress(operator, made.id, 'maple-grove')
    const to = await emailOf(owner.userId)
    const [notice, ...more] = noticesTo(to)
    expect(more).toEqual([])
    expect(notice?.subject).toBe('Your server has a new address')
    expect(notice?.text).toBe(
      [
        'Your server “Maple Hollow” moved from maple-old.play.test to maple-grove.play.test. Short addresses like “maple-old” are kept for Cubepals, so nobody mistakes a server for ours.',
        '',
        'Your world and settings didn’t change. You can pick another address in your server’s settings.',
        `http://localhost:3000/servers/${made.id}`,
        '',
        'This mailbox isn’t read.',
        '',
        'Cubepals',
      ].join('\n'),
    )
    expect(notice?.html).toContain('This mailbox isn’t read.')
    expect(notice?.html).not.toContain('Reply to this email')
    // Nothing else went out to the owner, from any sender.
    expect(h.mail.to(to)).toHaveLength(1)

    // The same address again changes nothing, so says nothing.
    await h.app.notices.changeAddress(operator, made.id, 'maple-grove')
    expect(noticesTo(to)).toHaveLength(1)
  })

  test('the owner’s own change, an admin’s on their own server included, sends nothing', async () => {
    const owner = await h.user('Steve', 'plus')
    const made = await h.create(owner, { name: 'Quiet one' })
    await h.app.notices.changeAddress(owner, made.id, 'quiet-one-moved')
    const admin: Actor = { kind: 'admin', userId: owner.userId }
    await h.app.notices.changeAddress(admin, made.id, 'quiet-one-again')
    await h.app.listings.setPublic(owner, made.id, true)
    await h.app.listings.setPublic(owner, made.id, false)
    expect(noticesTo(await emailOf(owner.userId))).toEqual([])
  })

  test('another admin’s new address tells the owner', async () => {
    const owner = await h.user('Alex', 'plus')
    const admin: Actor = { kind: 'admin', userId: (await h.user('Admin')).userId }
    const made = await h.create(owner, { name: 'Lobby three' })
    await h.app.notices.changeAddress(admin, made.id, 'lobby-three-moved')
    expect(noticesTo(await emailOf(owner.userId)).map((m) => m.subject)).toEqual([
      'Your server has a new address',
    ])
  })

  test('an operator taking it out of Browse tells the owner once; an unlisted one stays quiet', async () => {
    const owner = await h.user('Robin')
    const made = await h.create(owner, { name: 'Castle <Builders>' })
    const to = await emailOf(owner.userId)
    await h.app.listings.setPublic(operator, made.id, false)
    expect(noticesTo(to)).toEqual([])
    await h.app.listings.setPublic(owner, made.id, true)
    await h.app.listings.setPublic(operator, made.id, false)
    await h.app.listings.setPublic(operator, made.id, false)
    const [notice, ...more] = noticesTo(to)
    expect(more).toEqual([])
    expect(notice?.subject).toBe('Your server is no longer listed in Browse')
    expect(notice?.text).toBe(
      [
        `We took “Castle <Builders>” out of the public server list. Your friends can still join it at ${made.slug}.play.test.`,
        `http://localhost:3000/servers/${made.id}`,
        '',
        'This mailbox isn’t read.',
        '',
        'Cubepals',
      ].join('\n'),
    )
    expect(notice?.html).toContain('Not in Browse')
    expect(notice?.html).not.toContain('<Builders>')
  })

  test('a change made before notices existed can be told; one that isn’t so is refused', async () => {
    const owner = await h.user('Kim')
    const made = await h.create(owner, { name: 'Moved before' })
    const to = await emailOf(owner.userId)
    await h.app.notices.addressChanged(operator, made.id, 'beta')
    expect(noticesTo(to).at(-1)?.text).toContain(`moved from beta.play.test to ${made.slug}.play.test`)
    expect(await refusal(h.app.notices.addressChanged(operator, made.id, made.slug))).toBe(
      `invalid_choice: The server's address is still ${made.slug}.`,
    )
    await h.app.listings.setPublic(owner, made.id, true)
    expect(await refusal(h.app.notices.unlisted(operator, made.id))).toBe(
      'invalid_choice: The server is still listed in Browse.',
    )
    expect(noticesTo(to)).toHaveLength(1)
  })
})

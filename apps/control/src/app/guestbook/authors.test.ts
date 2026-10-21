// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who left each note on a public server, as everyone signed in reads it: a first name and a last
 * initial, or no name for a note left as anonymous, and the seed of each writer's picture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { GuestbookService } from './service.ts'

describe.skipIf(!hasDatabase)('who left a note', () => {
  let h: Harness
  let id = ''

  beforeAll(async () => {
    h = await startHarness()
    const owner = await h.user('Steve')
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    id = created.id
    await h.app.listings.setPublic(owner, id, true)
  }, 60_000)

  afterAll(async () => {
    await h.close()
  })

  test('a note shows who left it, and one left as anonymous stays that way', async () => {
    const davi = await h.user('Davi Hernandez')
    const ana = await h.user('Ana')
    const nameless = await h.user('')
    await h.app.guestbook.addNote(davi, id, 'Great builds')
    await h.app.guestbook.addNote(davi, id, 'Back again')
    await h.app.guestbook.addNote(ana, id, 'Friendly folks')
    await h.app.guestbook.addNote(nameless, id, 'Nice spawn')
    // Written before notes showed names: anonymous, whoever wrote it.
    const unsigned = (authorId: string, body: string) =>
      h.db.insert(schema.serverNotes).values({ serverId: id, authorId, body, signed: false })
    await unsigned(davi.userId, 'Old')
    await unsigned(ana.userId, 'Older')

    const read = await h.app.guestbook.notes(ana, id)
    expect(read.signature).toBe('Ana')
    const by = (body: string) => read.notes.find((note) => note.body === body)
    expect(by('Great builds')?.author).toBe('Davi H.')
    expect(by('Friendly folks')?.author).toBe('Ana')
    expect(by('Nice spawn')?.author).toBeNull()
    expect(by('Old')?.author).toBeNull()
    expect(by('Older')?.author).toBeNull()
    // The same writer has the same picture on every note; it isn't their id, nor anyone else's.
    expect(by('Great builds')?.avatar).toEqual(by('Back again')?.avatar)
    expect(by('Great builds')?.avatar.seed).not.toContain(davi.userId)
    expect(by('Great builds')?.avatar.seed).not.toBe(by('Friendly folks')?.avatar.seed)
    // Every anonymous note shares one picture, whoever wrote it, and it is nobody's own.
    expect(by('Old')?.avatar).toEqual(by('Older')?.avatar)
    expect(by('Old')?.avatar.seed).not.toBe(by('Great builds')?.avatar.seed)

    expect((await h.app.guestbook.notes(nameless, id)).signature).toBeNull()
  }, 30_000)

  const written = (authorId: string, body: string) =>
    h.db.insert(schema.serverNotes).values({ serverId: id, authorId, body })

  /** The guestbook as it reads with only these picture styles on offer for new writers. */
  const offering = (...avatarStyles: ('identicon' | 'pixel' | 'minidenticon')[]) =>
    // Reading notes never asks the access policy.
    new GuestbookService({ db: h.db, policy: undefined as never, avatarStyles })

  test('a picture is kept for good: other styles on offer later change nobody’s', async () => {
    const kit = await h.user('Kit Marlowe')
    // Written straight in, so this reading is the first time anyone is shown it.
    await written(kit.userId, 'Kept for good')
    const reader = await h.user('Reader')
    const first = (await offering('identicon').notes(reader, id)).notes.find(
      (n) => n.body === 'Kept for good',
    )
    expect(first?.avatar.style).toBe('identicon')

    const later = offering('pixel')
    const again = (await later.notes(reader, id)).notes.find((n) => n.body === 'Kept for good')
    expect(again?.avatar).toEqual(first?.avatar)
    // Someone shown for the first time gets a style from what is on offer now.
    const lee = await h.user('Lee')
    await written(lee.userId, 'New here')
    const lees = (await later.notes(reader, id)).notes.find((n) => n.body === 'New here')
    expect(lees?.avatar.style).toBe('pixel')
  }, 30_000)

  test('a new name changes the name shown, never the picture', async () => {
    const mo = await h.user('Mo Rahman')
    await h.app.guestbook.addNote(mo, id, 'Renamed later')
    const reader = await h.user('Reader')
    const mine = async () =>
      (await h.app.guestbook.notes(reader, id)).notes.find((n) => n.body === 'Renamed later')
    const before = await mine()
    await h.db.update(schema.users).set({ name: 'Morgan Lee' }).where(eq(schema.users.id, mo.userId))
    const after = await mine()
    expect(before?.author).toBe('Mo R.')
    expect(after?.author).toBe('Morgan L.')
    expect(after?.avatar).toEqual(before?.avatar)
  }, 30_000)

  test('a name that passes for Cubepals shows as anonymous', async () => {
    const reader = await h.user('Reader')
    for (const [name, body] of [
      ['Cubepals Team', 'From the team'],
      ['Official Ana', 'Official word'],
      ['Ana St4ff', 'Staff here'],
    ] as const) {
      const writer = await h.user(name)
      await written(writer.userId, body)
    }
    const read = await h.app.guestbook.notes(reader, id)
    for (const body of ['From the team', 'Official word', 'Staff here'])
      expect(read.notes.find((n) => n.body === body)?.author).toBeNull()
    expect((await h.app.guestbook.notes(await h.user('Cubepals'), id)).signature).toBeNull()
  }, 30_000)
})

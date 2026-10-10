// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { NOTES_SHOWN } from '@blockly/contracts'
import { schema } from '@blockly/db'
import { and, eq, sql } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import type { Actor, UserActor } from '../actor.ts'

// Stars and notes on a public server end to end: set, counted where the server is found, held to
// what strangers can see, paced, and cleaned up with the account or the server they belong to.
describe.skipIf(!hasDatabase)('guestbook', () => {
  let h: Harness
  let owner: UserActor
  let id = ''
  let slug = ''
  let code = ''
  /** A platform admin, as they sign in (a person) and as the admin pages act (`admin`). */
  let adminUser: UserActor
  let admin: Actor

  // Booting is the slow part, so one public server serves every test.
  beforeAll(async () => {
    h = await startHarness()
    adminUser = await h.user('Admin')
    await h.db.insert(schema.platformAdmins).values({ userId: adminUser.userId, grantedBy: 'test' })
    admin = { kind: 'admin', userId: adminUser.userId }
    owner = await h.user('Steve')
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    id = created.id
    slug = created.slug
    code = created.inviteCode
    await h.app.servers.saveIdentity(owner, id, { name: 'Castle Builders' })
    await h.app.listings.setPublic(owner, id, true)
  }, 60_000)

  afterAll(async () => {
    await h.close()
  })

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code?: string; name: string }) => error.code ?? error.name,
    )
  /** Each test starts from an empty guestbook. */
  const fresh = async () => {
    await h.db.delete(schema.serverStars).where(eq(schema.serverStars.serverId, id))
    await h.db.delete(schema.serverNotes).where(eq(schema.serverNotes.serverId, id))
  }
  /** Moves an actor's audited actions out of the last minute. */
  const aMinuteLater = (actor: string) =>
    h.db
      .update(schema.auditLog)
      .set({ at: sql`${schema.auditLog.at} - interval '2 minutes'` })
      .where(eq(schema.auditLog.actor, actor))
  const audited = (action: string) =>
    h.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectId, id)))
      .orderBy(schema.auditLog.at)
  const card = async (viewer: Actor | null) =>
    (await h.app.listingQueries.browse({ search: '', tag: null, offset: 0 }, viewer)).listings.find(
      (listing) => listing.serverId === id,
    )?.reactions

  test('a star is set, not toggled, and counted wherever the server is found', async () => {
    await fresh()
    const alex = await h.user('Alex')
    const sam = await h.user('Sam')
    expect(await h.app.guestbook.star(alex, id, true)).toEqual({ stars: 1, starred: true })
    // A retry or a double click changes nothing, and puts nothing on the record.
    expect(await h.app.guestbook.star(alex, id, true)).toEqual({ stars: 1, starred: true })
    expect(await h.app.guestbook.star(sam, id, true)).toEqual({ stars: 2, starred: true })
    const starred = await audited('listing.starred')
    expect(starred.filter((row) => row.actor === `user:${alex.userId}`)).toHaveLength(1)

    expect(await card(alex)).toEqual({ serverId: id, stars: 2, starred: true, notes: 0, yours: false })
    expect(await card(null)).toMatchObject({ stars: 2, starred: false, yours: false })
    expect(await card(owner)).toMatchObject({ stars: 2, starred: false, yours: true })
    expect((await h.app.listingQueries.detail(id, sam)).reactions).toMatchObject({ stars: 2, starred: true })
    expect((await h.app.listingQueries.detail(id)).reactions.starred).toBe(false)

    // The page people open counts them; the status bots fetch and an invitation don't.
    expect((await h.app.sharingQueries.page(slug, alex, { reactions: true }))?.reactions).toEqual({
      serverId: id,
      stars: 2,
      starred: true,
      notes: 0,
      yours: false,
    })
    expect((await h.app.sharingQueries.page(slug, null, { reactions: true }))?.reactions).toMatchObject({
      stars: 2,
      starred: false,
    })
    expect((await h.app.sharingQueries.page(slug, owner, { reactions: true }))?.reactions).toMatchObject({
      yours: true,
    })
    expect((await h.app.sharingQueries.page(slug, alex))?.reactions).toBeNull()
    expect((await h.app.sharingQueries.invite(code, alex))?.reactions).toBeNull()

    expect(await h.app.guestbook.star(alex, id, false)).toEqual({ stars: 1, starred: false })
    expect(await h.app.guestbook.star(alex, id, false)).toEqual({ stars: 1, starred: false })
    expect((await audited('listing.starred')).map((row) => row.data)).toEqual([
      { starred: true },
      { starred: true },
      { starred: false },
    ])
    // Owners don't star their own server.
    expect(await refusal(h.app.guestbook.star(owner, id, true))).toBe('invalid_choice')
  }, 30_000)

  test('only a server strangers can see takes stars and notes', async () => {
    await fresh()
    const alex = await h.user('Alex')
    await h.app.listings.setPublic(owner, id, false)
    expect(await refusal(h.app.guestbook.star(alex, id, true))).toBe('NotFound')
    expect(await refusal(h.app.guestbook.notes(alex, id))).toBe('NotFound')
    expect(await refusal(h.app.guestbook.addNote(alex, id, 'Hello'))).toBe('NotFound')
    // Its owner's preview has nothing to count either.
    expect((await h.app.sharingQueries.page(slug, owner, { reactions: true }))?.reactions).toBeNull()
    await h.app.listings.setPublic(owner, id, true)

    // Nor while the directory is paused: the page is gone then too.
    await h.db.update(schema.platformControls).set({ publicListingEnabled: false })
    expect(await refusal(h.app.guestbook.star(alex, id, true))).toBe('NotFound')
    await h.db.update(schema.platformControls).set({ publicListingEnabled: true })
    expect(await h.app.guestbook.star(alex, id, true)).toEqual({ stars: 1, starred: true })
    expect(await refusal(h.app.guestbook.notes(alex, randomUUID()))).toBe('NotFound')
  }, 30_000)

  test('notes come newest first, a few at a time, cleaned to one plain line', async () => {
    await fresh()
    for (const name of ['Alex', 'Sam', 'Jo']) {
      const person = await h.user(name)
      for (let i = 1; i <= 3; i++) await h.app.guestbook.addNote(person, id, `${name} ${i}`)
    }
    const reader = await h.user('Reader')
    const read = await h.app.guestbook.notes(reader, id)
    expect(read.total).toBe(9)
    expect(read.notes).toHaveLength(NOTES_SHOWN)
    expect(read.notes.map((note) => note.body)).toEqual(['Jo 3', 'Jo 2', 'Jo 1', 'Sam 3', 'Sam 2', 'Sam 1'])
    expect(read.notes.every((note) => !note.yours && !note.byOwner && !note.canDelete)).toBe(true)

    // Nothing in a note can reorder the page or run over lines.
    const written = await h.app.guestbook.addNote(
      reader,
      id,
      `  Great\n\nbuilds ${String.fromCodePoint(0x202e)}here `,
    )
    expect(written.notes[0]).toMatchObject({ body: 'Great builds here', yours: true, canDelete: true })
    expect(written.total).toBe(10)
    expect(await refusal(h.app.guestbook.addNote(reader, id, 'a'.repeat(129)))).toBe('invalid_choice')
    expect(await refusal(h.app.guestbook.addNote(reader, id, '   '))).toBe('invalid_choice')
    expect(await refusal(h.app.guestbook.addNote(reader, id, String.fromCodePoint(0x202e, 0x200b)))).toBe(
      'invalid_choice',
    )

    // The owner signs their own guestbook, marked as theirs, and may delete anything in it.
    const welcomed = await h.app.guestbook.addNote(owner, id, 'Welcome, everyone')
    expect(welcomed.notes[0]).toMatchObject({ body: 'Welcome, everyone', byOwner: true, yours: true })
    expect(welcomed.notes.every((note) => note.canDelete)).toBe(true)
    expect((await h.app.guestbook.notes(reader, id)).notes[0]).toMatchObject({
      byOwner: true,
      yours: false,
      canDelete: false,
    })
    expect(await card(reader)).toMatchObject({ notes: 11 })
    expect((await h.app.sharingQueries.page(slug, null, { reactions: true }))?.reactions?.notes).toBe(11)
  }, 30_000)

  test('one person leaves a few notes here, each once, at a writing pace', async () => {
    await fresh()
    const alex = await h.user('Alex')
    await h.app.guestbook.addNote(alex, id, 'Hello there')
    await expect(h.app.guestbook.addNote(alex, id, 'HELLO   there')).rejects.toMatchObject({
      code: 'invalid_choice',
      message: 'You left that note already.',
    })
    await h.app.guestbook.addNote(alex, id, 'Second')
    await h.app.guestbook.addNote(alex, id, 'Third')
    expect(await refusal(h.app.guestbook.addNote(alex, id, 'Fourth'))).toBe('rate_limited')

    await aMinuteLater(`user:${alex.userId}`)
    await expect(h.app.guestbook.addNote(alex, id, 'Fourth')).rejects.toMatchObject({
      code: 'invalid_choice',
      message: 'You have left three notes here already. Delete one to leave another.',
    })
    const mine = await h.app.guestbook.notes(alex, id)
    const second = mine.notes.find((note) => note.body === 'Second')
    if (second === undefined) throw new Error('The note is missing')
    await h.app.guestbook.deleteNote(alex, second.id)
    expect((await h.app.guestbook.addNote(alex, id, 'Fourth')).notes.map((note) => note.body)).toEqual([
      'Fourth',
      'Third',
      'Hello there',
    ])

    // A day's worth, however slowly it was written, is enough.
    const sam = await h.user('Sam')
    await h.db.insert(schema.auditLog).values(
      Array.from({ length: 20 }, () => ({
        actor: `user:${sam.userId}`,
        action: 'listing.note_added',
        subjectType: 'server',
        subjectId: id,
        at: new Date(Date.now() - 3_600_000),
      })),
    )
    await expect(h.app.guestbook.addNote(sam, id, 'One more')).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'That is a lot of notes for one day. Try again tomorrow.',
    })
  }, 30_000)

  test('stars change at a clicking pace, not a script’s', async () => {
    await fresh()
    const alex = await h.user('Alex')
    // Thirty changes in a minute are plenty for a person; a set that changes nothing costs none.
    for (let i = 0; i < 30; i++) await h.app.guestbook.star(alex, id, i % 2 === 0)
    expect(await refusal(h.app.guestbook.star(alex, id, true))).toBe('rate_limited')
    await aMinuteLater(`user:${alex.userId}`)
    expect(await h.app.guestbook.star(alex, id, true)).toEqual({ stars: 1, starred: true })
  }, 30_000)

  test('a note takes a confirmed email and good standing; a star, good standing', async () => {
    await fresh()
    const unconfirmed = await h.user('Alex')
    await h.db
      .update(schema.users)
      .set({ emailVerified: false })
      .where(eq(schema.users.id, unconfirmed.userId))
    expect(await refusal(h.app.guestbook.addNote(unconfirmed, id, 'Hello'))).toBe('email_unverified')
    expect(await h.app.guestbook.star(unconfirmed, id, true)).toEqual({ stars: 1, starred: true })

    const suspended = await h.user('Sam')
    await h.app.accounts.suspend(admin, suspended.userId, 'spam')
    expect(await refusal(h.app.guestbook.addNote(suspended, id, 'Hello'))).toBe('account_suspended')
    expect(await refusal(h.app.guestbook.star(suspended, id, true))).toBe('account_suspended')
  }, 30_000)

  test('a note is deleted by its author, the owner or an admin, and nobody else', async () => {
    await fresh()
    const alex = await h.user('Alex')
    const stranger = await h.user('Sam')
    const first = (await h.app.guestbook.addNote(alex, id, 'From Alex')).notes[0]
    if (first === undefined) throw new Error('The note is missing')
    expect(first).toMatchObject({ yours: true, canDelete: true })
    expect((await h.app.guestbook.notes(stranger, id)).notes[0]?.canDelete).toBe(false)
    expect((await h.app.guestbook.notes(owner, id)).notes[0]?.canDelete).toBe(true)
    // An admin signs in as anyone does; the admin table says what they may do.
    expect((await h.app.guestbook.notes(adminUser, id)).notes[0]?.canDelete).toBe(true)
    expect((await h.app.guestbook.notes(admin, id)).notes[0]?.canDelete).toBe(true)

    expect(await refusal(h.app.guestbook.deleteNote(stranger, first.id))).toBe('NotFound')
    // Its author takes it back quietly.
    expect(await h.app.guestbook.deleteNote(alex, first.id)).toEqual({ notes: [], total: 0 })
    expect(await audited('listing.note_removed')).toEqual([])
    expect(await refusal(h.app.guestbook.deleteNote(alex, first.id))).toBe('NotFound')

    // The owner and an admin removing one is on the record, with what it said.
    const second = (await h.app.guestbook.addNote(alex, id, 'Again from Alex')).notes[0]
    const third = (await h.app.guestbook.addNote(alex, id, 'Third from Alex')).notes[0]
    if (second === undefined || third === undefined) throw new Error('A note is missing')
    const left = await h.app.guestbook.deleteNote(owner, second.id)
    expect(left).toMatchObject({ total: 1, notes: [{ id: third.id, canDelete: true, yours: false }] })
    expect(await h.app.guestbook.deleteNote(adminUser, third.id)).toEqual({ notes: [], total: 0 })
    const removed = await audited('listing.note_removed')
    expect(removed.map((row) => [row.actor, row.data])).toEqual([
      [`user:${owner.userId}`, { noteId: second.id, authorId: alex.userId, body: 'Again from Alex' }],
      [`admin:${adminUser.userId}`, { noteId: third.id, authorId: alex.userId, body: 'Third from Alex' }],
    ])
  }, 30_000)

  test('closing an account takes its stars and notes with it', async () => {
    await fresh()
    const alex = await h.user('Alex')
    const sam = await h.user('Sam')
    for (const person of [alex, sam]) {
      await h.app.guestbook.star(person, id, true)
      await h.app.guestbook.addNote(person, id, 'Lovely place')
    }
    await h.app.accounts.terminate(admin, alex.userId, 'spam')
    expect(await h.app.guestbook.notes(sam, id)).toMatchObject({ total: 1, notes: [{ yours: true }] })
    expect(await card(sam)).toMatchObject({ stars: 1, notes: 1, starred: true })
  }, 30_000)

  // Last: it deletes the server every other test uses.
  test('a deleted server takes nothing new, and purged, its guestbook goes', async () => {
    await fresh()
    const alex = await h.user('Alex')
    const sam = await h.user('Sam')
    await h.app.guestbook.star(alex, id, true)
    const note = (await h.app.guestbook.addNote(alex, id, 'Goodbye')).notes[0]
    await h.app.guestbook.addNote(alex, id, 'See you')
    await h.app.guestbook.addNote(sam, id, 'Farewell from Sam')
    if (note === undefined) throw new Error('The note is missing')
    await h.app.servers.deleteServer(owner, id, (await h.server(id)).name)
    await h.until(id, 'deleted')
    await h.settled(id)
    expect(await refusal(h.app.guestbook.star(alex, id, false))).toBe('NotFound')
    expect(await refusal(h.app.guestbook.notes(alex, id))).toBe('NotFound')
    // A note can still be taken back where nobody can read it any more, and taking it back shows
    // nobody else's; its owner still sees what is left, to clean up.
    expect(await h.app.guestbook.deleteNote(alex, note.id)).toEqual({ notes: [], total: 0 })
    const left = await h.db.select().from(schema.serverNotes).where(eq(schema.serverNotes.serverId, id))
    const sams = left.find((n) => n.body === 'Farewell from Sam')
    if (sams === undefined) throw new Error("Sam's note is missing")
    expect(await h.app.guestbook.deleteNote(owner, sams.id)).toMatchObject({ total: 1 })

    await h.db
      .update(schema.minecraftServers)
      .set({ purgeAfter: sql`now() - interval '1 hour'` })
      .where(eq(schema.minecraftServers.id, id))
    await h.app.schedules.purgeSweep()
    await h.until(id, 'purged', 20_000)
    await h.settled(id)
    const stars = await h.db.select().from(schema.serverStars).where(eq(schema.serverStars.serverId, id))
    const notes = await h.db.select().from(schema.serverNotes).where(eq(schema.serverNotes.serverId, id))
    expect([stars, notes]).toEqual([[], []])
  }, 60_000)
})

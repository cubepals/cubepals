// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who left each note on a public server, as everyone signed in reads it: a first name and a last
 * initial, or no name for a note left as anonymous, and the seed of each writer's picture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

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
    expect(by('Great builds')?.avatar).toBe(by('Back again')?.avatar as string)
    expect(by('Great builds')?.avatar).not.toContain(davi.userId)
    expect(by('Great builds')?.avatar).not.toBe(by('Friendly folks')?.avatar as string)
    // Every anonymous note shares one picture, whoever wrote it, and it is nobody's own.
    expect(by('Old')?.avatar).toBe(by('Older')?.avatar as string)
    expect(by('Old')?.avatar).not.toBe(by('Great builds')?.avatar as string)

    expect((await h.app.guestbook.notes(nameless, id)).signature).toBeNull()
  }, 30_000)
})

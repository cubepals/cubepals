// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import {
  AVATAR_STYLES,
  type AvatarStyle,
  type AvatarView,
  NOTES_SHOWN,
  type NotesView,
  type StarView,
} from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'
import { offensive } from '@blockly/contracts/names'
import { type Db, type Queryable, schema, type Tx } from '@blockly/db'
import { pickStyle, shownName } from '../../domain/listing/author.ts'
import { cleanNote, sameNote } from '../../domain/listing/note.ts'
import { saysOfficial } from '../../domain/server/held-names.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { actionsSince, isAdmin, loadControls, loadStanding } from '../accounts/persistence.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { loadListing } from '../listings/persistence.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import { findServer } from '../servers/persistence.ts'
import {
  accountName,
  countNotes,
  countStars,
  deleteNote,
  insertNote,
  keepAvatarStyles,
  keptAvatarStyles,
  latestNotes,
  loadNote,
  notesBy,
  setStar,
} from './persistence.ts'

/** Notes one person may leave in a day, across every server: past the minute's limit, a script. */
const NOTES_A_DAY = 20

/** Notes one person keeps on one server: a guestbook signed, not a conversation. */
const NOTES_KEPT = 3

/** The picture every note left as anonymous shares, so none of them looks like someone's. */
const ANONYMOUS_AVATAR: AvatarView = { style: 'mark', seed: 'a-player' }

/**
 * Stars and short notes on public servers: a guestbook, never a community. Only a server
 * strangers can see takes them; deleting a note is its author's, its server owner's, or an
 * admin's, wherever the server stands now.
 */
export class GuestbookService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  /** The picture styles a new writer may be given; every style ever given can still be drawn. */
  readonly #avatarStyles: readonly AvatarStyle[]

  constructor(deps: { db: Db; policy: AccessPolicy; avatarStyles?: readonly AvatarStyle[] }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#avatarStyles = deps.avatarStyles ?? AVATAR_STYLES
  }

  /** Set, not toggled, so a retry or a double click changes nothing. */
  async star(actor: Actor, serverId: string, starred: boolean): Promise<StarView> {
    const userId = personOf(actor, 'Listing')
    return this.#db.transaction(async (tx) => {
      const server = await shownServer(tx, serverId)
      if (server.ownerId === userId) throw new AppError('invalid_choice', 'This is your own server.')
      await this.#policy.require(tx, userId, { kind: 'star_server' })
      if (await setStar(tx, server.id, userId, starred))
        await audit(tx, actor, 'listing.starred', server.id, { starred })
      return { stars: await countStars(tx, server.id), starred }
    })
  }

  async notes(actor: Actor, serverId: string): Promise<NotesView> {
    const userId = personOf(actor, 'Listing')
    const server = await shownServer(this.#db, serverId)
    return notesView(this.#db, server, userId, await asAdmin(this.#db, actor), this.#avatarStyles)
  }

  async addNote(actor: Actor, serverId: string, body: string): Promise<NotesView> {
    const userId = personOf(actor, 'Listing')
    return this.#db.transaction(async (tx) => {
      const server = await shownServer(tx, serverId)
      const cleaned = cleanNote(body)
      if ('refused' in cleaned) throw new AppError('invalid_choice', cleaned.refused)
      // Takes the account's own lock, so the counts below can't be raced past.
      await this.#policy.require(tx, userId, { kind: 'leave_note' })
      const aDayAgo = new Date(Date.now() - DAY_MS)
      if ((await actionsSince(tx, requestedBy(actor), 'listing.note_added', aDayAgo)) >= NOTES_A_DAY)
        throw new AppError('rate_limited', 'That is a lot of notes for one day. Try again tomorrow.')
      const kept = await notesBy(tx, server.id, userId)
      if (kept.length >= NOTES_KEPT)
        throw new AppError(
          'invalid_choice',
          'You have left three notes here already. Delete one to leave another.',
        )
      if (kept.some((note) => sameNote(note.body, cleaned.note)))
        throw new AppError('invalid_choice', 'You left that note already.')
      const noteId = await insertNote(tx, { serverId: server.id, authorId: userId, body: cleaned.note })
      await audit(tx, actor, 'listing.note_added', server.id, { noteId })
      return notesView(tx, server, userId, await asAdmin(tx, actor), this.#avatarStyles)
    })
  }

  /**
   * Its author takes a note back quietly; its server's owner or an admin removing it is on the
   * record, with what it said. Anyone else is told there is no such note.
   */
  async deleteNote(actor: Actor, noteId: string): Promise<NotesView> {
    const userId = personOf(actor, 'Note')
    return this.#db.transaction(async (tx) => {
      const note = await loadNote(tx, noteId)
      if (note === null) throw new NotFound('Note')
      const server = await findServer(tx, note.serverId)
      if (server === null) throw new NotFound('Note')
      const admin = await asAdmin(tx, actor)
      const author = note.authorId === userId
      const owner = server.ownerId === userId
      if (!author && !owner && !admin) throw new NotFound('Note')
      if (!(await deleteNote(tx, note.id))) throw new NotFound('Note')
      if (!author)
        await audit(tx, owner ? actor : { kind: 'admin', userId }, 'listing.note_removed', server.id, {
          noteId: note.id,
          authorId: note.authorId,
          body: note.body,
        })
      // Where strangers can't read the guestbook any more, its author sees only that theirs went.
      return owner || admin || (await isShown(tx, server))
        ? notesView(tx, server, userId, admin, this.#avatarStyles)
        : { notes: [], total: 0, signature: noteName(await accountName(tx, userId)) }
    })
  }
}

/** The person asking. The platform itself neither stars nor writes. */
function personOf(actor: Actor, what: string): string {
  if (actor.kind === 'system' || actor.kind === 'operator') throw new NotFound(what)
  return actor.userId
}

/**
 * Signed-in people arrive as themselves, so whether one is a platform admin, who may remove any
 * note, is looked up rather than taken from how they came in.
 */
async function asAdmin(q: Queryable, actor: Actor): Promise<boolean> {
  return actor.kind === 'admin' || (actor.kind === 'user' && (await isAdmin(q, actor.userId)))
}

/**
 * The server behind a page strangers can see, or nothing: its owner made it public, no admin
 * removed it, the directory isn't paused, the owner is in good standing and it isn't deleted.
 * The page's own rule, so wherever the page opens, its guestbook does too.
 */
async function shownServer(q: Queryable, serverId: string): Promise<MinecraftServer> {
  const server = await findServer(q, serverId)
  if (server === null || !(await isShown(q, server))) throw new NotFound('Listing')
  return server
}

async function isShown(q: Queryable, server: MinecraftServer): Promise<boolean> {
  if (server.deletedAt !== null) return false
  const listing = await loadListing(q, server.id)
  return (
    listing?.visibility === 'published' &&
    listing.moderation === 'clear' &&
    (await loadControls(q)).publicListingEnabled &&
    (await loadStanding(q, server.ownerId)).status === 'active'
  )
}

/**
 * The latest notes as one person reads them: who left each, and which they may delete. A note left
 * as anonymous shows no name and the shared picture, whoever wrote it.
 */
async function notesView(
  q: Queryable,
  server: MinecraftServer,
  viewerId: string,
  admin: boolean,
  styles: readonly AvatarStyle[],
): Promise<NotesView> {
  const latest = await latestNotes(q, server.id, NOTES_SHOWN)
  const pictures = await avatarsOf(
    q,
    latest.filter((note) => note.signed).map((note) => note.authorId),
    styles,
  )
  return {
    notes: latest.map((note) => ({
      id: note.id,
      body: note.body,
      at: note.createdAt.toISOString(),
      author: note.signed ? noteName(note.authorName) : null,
      avatar: (note.signed && pictures.get(note.authorId)) || ANONYMOUS_AVATAR,
      yours: note.authorId === viewerId,
      byOwner: note.authorId === server.ownerId,
      canDelete: note.authorId === viewerId || server.ownerId === viewerId || admin,
    })),
    total: await countNotes(q, server.id),
    signature: noteName(await accountName(q, viewerId)),
  }
}

/**
 * The name a note shows for an account, held to the rule a server's name is: nothing offensive,
 * and nothing that says Cubepals, Official, Verified or Staff, so no note passes for ours. Such an
 * account's notes show as anonymous ones do.
 */
const noteName = (name: string): string | null =>
  offensive(name) || saysOfficial(name) ? null : shownName(name)

/**
 * A writer's picture seed: a hash of their account's id, so the same writer has the same picture on
 * every note and nothing about them can be read back from it.
 */
const avatarSeed = (authorId: string): string =>
  createHash('sha256').update(authorId).digest('hex').slice(0, 32)

/**
 * Each writer's picture: the style kept for them, or, the first time they are shown, one given
 * from their seed and kept for good, so changing the styles on offer changes nobody's.
 */
async function avatarsOf(
  q: Queryable,
  authorIds: string[],
  styles: readonly AvatarStyle[],
): Promise<Map<string, AvatarView>> {
  const ids = [...new Set(authorIds)]
  let kept = await keptAvatarStyles(q, ids)
  const fresh = ids.filter((id) => !kept.has(id))
  if (fresh.length > 0) {
    await keepAvatarStyles(
      q,
      fresh.map((id) => ({ userId: id, style: pickStyle(avatarSeed(id), styles) })),
    )
    // Two readers can give a writer a style at once; the one kept is the one shown.
    kept = await keptAvatarStyles(q, ids)
  }
  return new Map(ids.map((id) => [id, { style: knownStyle(kept.get(id)), seed: avatarSeed(id) }]))
}

/** A kept style as the contracts name it; one they no longer list is drawn as the mark. */
const knownStyle = (style: string | undefined): AvatarStyle =>
  AVATAR_STYLES.find((known) => known === style) ?? 'mark'

async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  serverId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(schema.auditLog)
    .values({ actor: requestedBy(actor), action, subjectType: 'server', subjectId: serverId, data })
}

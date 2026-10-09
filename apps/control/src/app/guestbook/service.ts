import { NOTES_SHOWN, type NotesView, type StarView } from '@blockly/contracts'
import { type Db, type Queryable, schema, type Tx } from '@blockly/db'
import { cleanNote, sameNote } from '../../domain/listing/note.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { actionsSince, isAdmin, loadControls, loadStanding } from '../accounts/persistence.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { loadListing } from '../listings/persistence.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import { findServer } from '../servers/persistence.ts'
import {
  countNotes,
  countStars,
  deleteNote,
  insertNote,
  latestNotes,
  loadNote,
  notesBy,
  setStar,
} from './persistence.ts'

/** Notes one person may leave in a day, across every server: past the minute's limit, a script. */
const NOTES_A_DAY = 20

/** Notes one person keeps on one server: a guestbook signed, not a conversation. */
const NOTES_KEPT = 3

/**
 * Stars and short notes on public servers: a guestbook, never a community. Only a server
 * strangers can see takes them; deleting a note is its author's, its server owner's, or an
 * admin's, wherever the server stands now.
 */
export class GuestbookService {
  readonly #db: Db
  readonly #policy: AccessPolicy

  constructor(deps: { db: Db; policy: AccessPolicy }) {
    this.#db = deps.db
    this.#policy = deps.policy
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
    return notesView(this.#db, server, userId, await asAdmin(this.#db, actor))
  }

  async addNote(actor: Actor, serverId: string, body: string): Promise<NotesView> {
    const userId = personOf(actor, 'Listing')
    return this.#db.transaction(async (tx) => {
      const server = await shownServer(tx, serverId)
      const cleaned = cleanNote(body)
      if ('refused' in cleaned) throw new AppError('invalid_choice', cleaned.refused)
      // Takes the account's own lock, so the counts below can't be raced past.
      await this.#policy.require(tx, userId, { kind: 'leave_note' })
      const aDayAgo = new Date(Date.now() - 86_400_000)
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
      return notesView(tx, server, userId, await asAdmin(tx, actor))
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
        ? notesView(tx, server, userId, admin)
        : { notes: [], total: 0 }
    })
  }
}

/** The person asking. The platform itself neither stars nor writes. */
function personOf(actor: Actor, what: string): string {
  if (actor.kind === 'system') throw new NotFound(what)
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

/** The latest notes as one person reads them: whose they are, and which they may delete. */
async function notesView(
  q: Queryable,
  server: MinecraftServer,
  viewerId: string,
  admin: boolean,
): Promise<NotesView> {
  const latest = await latestNotes(q, server.id, NOTES_SHOWN)
  return {
    notes: latest.map((note) => ({
      id: note.id,
      body: note.body,
      at: note.createdAt.toISOString(),
      yours: note.authorId === viewerId,
      byOwner: note.authorId === server.ownerId,
      canDelete: note.authorId === viewerId || server.ownerId === viewerId || admin,
    })),
    total: await countNotes(q, server.id),
  }
}

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

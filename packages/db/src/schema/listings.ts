/**
 * The public directory: listings, the reports against them, and the stars and notes strangers
 * leave on public servers.
 */
import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgEnum, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import type { IneligibleReasonJson } from '../json.ts'
import { users } from './auth.ts'
import { createdAt, ts, updatedAt } from './columns.ts'
import { minecraftServers } from './servers.ts'

// ─── Public listings and moderation ─────────────────────────────────────────────────────────

export const listingVisibility = pgEnum('listing_visibility', ['draft', 'published', 'unpublished'])
export const listingModeration = pgEnum('listing_moderation', ['clear', 'removed'])

/**
 * Whether a server is public (§15.3): the owner's choice, an admin's moderation, and the
 * eligibility read model that decides whether the directory shows it. What the server is called
 * and says lives on the server itself. `draft` is no longer written; `published` means public.
 */
export const publicListings = pgTable(
  'public_listings',
  {
    serverId: uuid('server_id')
      .primaryKey()
      .references(() => minecraftServers.id),
    visibility: listingVisibility('visibility').notNull().default('unpublished'),
    moderation: listingModeration('moderation').notNull().default('clear'),
    moderationNote: text('moderation_note'),
    /** The owner lets others make a server like this one; only a setup Blockly vouches for can be. */
    copyable: boolean('copyable').notNull().default(true),
    // A read model: recomputable from local tables at any time.
    eligible: boolean('eligible').notNull().default(false),
    ineligibleReasons: jsonb('ineligible_reasons').$type<IneligibleReasonJson[]>().notNull().default([]),
    evaluatedRevisionId: uuid('evaluated_revision_id'),
    evaluatedAt: ts('evaluated_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('listings_browse')
      .on(t.updatedAt)
      .where(sql`${t.visibility} = 'published' and ${t.moderation} = 'clear' and ${t.eligible}`),
  ],
)

export const reportStatus = pgEnum('report_status', ['open', 'dismissed', 'actioned'])

export const listingReports = pgTable(
  'listing_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    reporterId: text('reporter_id')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    status: reportStatus('status').notNull().default('open'),
    createdAt: createdAt(),
  },
  (t) => [index('listing_reports_open').on(t.createdAt).where(sql`${t.status} = 'open'`)],
)

/**
 * Who starred a public server: one row a person, so the count is people, not clicks. Purging the
 * server, or closing the account, removes them.
 */
export const serverStars = pgTable(
  'server_stars',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.userId] }), index('server_stars_user').on(t.userId)],
)

/**
 * Short notes left on a public server, a guestbook: flat, a line each, anonymous apart from who
 * wrote it being its author or the owner. Deleted outright by their author, the server's owner or
 * an admin; purging the server, or closing the author's account, removes them too.
 */
export const serverNotes = pgTable(
  'server_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => minecraftServers.id),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    /** As shown: cleaned to one line, 1 to 128 characters as a browser counts them. */
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('server_notes_server').on(t.serverId, t.createdAt),
    index('server_notes_author').on(t.authorId, t.createdAt),
    check('server_notes_body_length', sql`char_length(${t.body}) between 1 and 128`),
  ],
)

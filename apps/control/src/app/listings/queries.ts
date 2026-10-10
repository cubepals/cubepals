import type {
  IneligibleCode,
  ListingCardView,
  OwnListingView,
  RemovedListingView,
  ReportView,
  TrustedProjectView,
} from '@blockly/contracts'
import { type Db, schema } from '@blockly/db'
import { inArray } from 'drizzle-orm'
import { formatJoinAddress } from '../../minecraft/address.ts'
import { loadControls } from '../accounts/persistence.ts'
import { type Actor, authorize } from '../actor.ts'
import { NotFound } from '../errors.ts'
import type { PlayAddressing } from '../ports/platform.ts'
import { findServer, loadRevision } from '../servers/persistence.ts'
import {
  allowlist,
  type DirectoryRow,
  directory,
  loadListing,
  openReports,
  removedListings,
} from './persistence.ts'

const PAGE = 24

/** The directory as everyone reads it, and listings as their owners and admins see them. */
export class ListingQueries {
  readonly #db: Db
  readonly #addressing: PlayAddressing

  constructor(deps: { db: Db; addressing: PlayAddressing }) {
    this.#db = deps.db
    this.#addressing = deps.addressing
  }

  /**
   * Published, clear, eligible listings (one indexed filter, §15.3). The platform's switch is
   * applied here, when the directory is read: paused, it is empty.
   */
  async browse(
    query: {
      search: string
      tag: string | null
      onlineNow?: boolean
      kind?: 'any' | 'vanilla' | 'modded'
      offset: number
    },
    viewer: Actor | null = null,
  ): Promise<{ listings: ListingCardView[]; total: number; paused: boolean }> {
    if (!(await loadControls(this.#db)).publicListingEnabled) return { listings: [], total: 0, paused: true }
    const viewerId = readerOf(viewer)
    const found = await directory(this.#db, { ...query, limit: PAGE, viewerId })
    return {
      listings: await Promise.all(found.rows.map((row) => this.#card(row, viewerId))),
      total: found.total,
      paused: false,
    }
  }

  /** One listing, only while the directory shows it. */
  async detail(serverId: string, viewer: Actor | null = null): Promise<ListingCardView> {
    if (!(await loadControls(this.#db)).publicListingEnabled) throw new NotFound('Listing')
    const viewerId = readerOf(viewer)
    const found = await directory(this.#db, {
      search: '',
      tag: null,
      offset: 0,
      limit: 1,
      serverId,
      viewerId,
    })
    const [row] = found.rows
    if (row === undefined) throw new NotFound('Listing')
    return this.#card(row, viewerId)
  }

  /** Where a server stands in the directory, as its owner sees it. */
  async own(actor: Actor, serverId: string): Promise<OwnListingView | null> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const listing = await loadListing(this.#db, server.id)
    if (listing === null) return null
    const paused = !(await loadControls(this.#db)).publicListingEnabled
    return {
      visibility: listing.visibility,
      moderation: listing.moderation,
      moderationNote: listing.moderationNote,
      eligible: listing.eligible,
      reasons: listing.ineligibleReasons.map((r) => ({
        code: r.code as IneligibleCode,
        ...(r.detail ? { detail: r.detail } : {}),
      })),
      visible:
        !paused &&
        listing.visibility === 'published' &&
        listing.moderation === 'clear' &&
        listing.eligible &&
        server.deletedAt === null,
      directoryPaused: paused,
    }
  }

  /** Open reports, newest first, with the listing they are about. */
  async reports(actor: Actor): Promise<ReportView[]> {
    if (actor.kind !== 'admin') throw new NotFound('Reports')
    const open = await openReports(this.#db)
    const reporters = new Map(
      (
        await this.#db
          .select({ id: schema.users.id, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, [...new Set(open.map((r) => r.reporterId)), '']))
      ).map((u) => [u.id, u.email]),
    )
    const views: ReportView[] = []
    for (const report of open) {
      const listing = await loadListing(this.#db, report.serverId)
      views.push({
        id: report.id,
        serverId: report.serverId,
        serverName: (await findServer(this.#db, report.serverId))?.name ?? 'A server',
        reason: report.reason,
        reporter: reporters.get(report.reporterId) ?? 'someone',
        createdAt: report.createdAt.toISOString(),
        moderation: listing?.moderation ?? 'clear',
      })
    }
    return views
  }

  /** Listings admins removed, with the note their owners see, to restore one. */
  async removed(actor: Actor): Promise<RemovedListingView[]> {
    if (actor.kind !== 'admin') throw new NotFound('Listings')
    const removed = await removedListings(this.#db)
    return Promise.all(
      removed.map(async (listing) => ({
        serverId: listing.serverId,
        name: (await findServer(this.#db, listing.serverId))?.name ?? 'A server',
        note: listing.moderationNote,
        removedAt: listing.updatedAt.toISOString(),
      })),
    )
  }

  async allowlist(actor: Actor): Promise<TrustedProjectView[]> {
    if (actor.kind !== 'admin') throw new NotFound('Allowlist')
    return (await allowlist(this.#db)).map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))
  }

  /** A server as a card: its own identity, the booted revision for what it runs, presence for who is on. */
  async #card(row: DirectoryRow, viewerId: string | null): Promise<ListingCardView> {
    const revision = row.revisionId === null ? null : await loadRevision(this.#db, row.revisionId)
    return {
      serverId: row.server.id,
      slug: row.server.slug,
      name: row.server.name,
      description: row.server.description,
      icon: row.server.icon,
      tags: row.server.tags,
      lastPlayedAt: row.lastPlayedAt?.toISOString() ?? null,
      joinAddress: formatJoinAddress(this.#addressing.primary(row.server.slug)),
      online: row.online,
      awake: row.server.status === 'running',
      whitelistOnly: row.whitelistEnabled,
      gameVersion: revision?.gameVersion ?? null,
      loader: revision?.loader ?? null,
      mods: revision?.mods.map((m) => m.name) ?? [],
      reactions: {
        serverId: row.server.id,
        stars: row.stars,
        starred: row.starred,
        notes: row.notes,
        yours: row.server.ownerId === viewerId,
      },
    }
  }
}

/** The person reading the directory, if anyone signed in is. */
const readerOf = (viewer: Actor | null): string | null =>
  viewer === null || viewer.kind === 'system' || viewer.kind === 'operator' ? null : viewer.userId

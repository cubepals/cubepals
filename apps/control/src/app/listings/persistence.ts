import { type IneligibleReasonJson, type Queryable, schema, type Tx } from '@blockly/db'
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm'

const listings = schema.publicListings
const reports = schema.listingReports
const trusted = schema.trustedModProjects
const servers = schema.minecraftServers
const runtimes = schema.serverRuntimes
const revisions = schema.serverRevisions

export interface ListingRecord {
  serverId: string
  visibility: 'draft' | 'published' | 'unpublished'
  moderation: 'clear' | 'removed'
  moderationNote: string | null
  copyable: boolean
  eligible: boolean
  ineligibleReasons: IneligibleReasonJson[]
  evaluatedRevisionId: string | null
  evaluatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export async function loadListing(q: Queryable, serverId: string): Promise<ListingRecord | null> {
  const [row] = await q.select().from(listings).where(eq(listings.serverId, serverId))
  return row ?? null
}

/** Public or not: the owner's own switch, and the only thing they set here. */
export async function setVisibility(
  tx: Tx,
  serverId: string,
  visibility: ListingRecord['visibility'],
): Promise<void> {
  await tx
    .insert(listings)
    .values({ serverId, visibility })
    .onConflictDoUpdate({ target: listings.serverId, set: { visibility, updatedAt: new Date() } })
}

/** Whether the owner lets others make a server like this one. */
export async function setCopyable(tx: Tx, serverId: string, copyable: boolean): Promise<void> {
  await tx
    .insert(listings)
    .values({ serverId, copyable })
    .onConflictDoUpdate({ target: listings.serverId, set: { copyable, updatedAt: new Date() } })
}

export async function setModeration(
  tx: Tx,
  serverId: string,
  moderation: ListingRecord['moderation'],
  note: string | null,
): Promise<void> {
  await tx
    .update(listings)
    .set({ moderation, moderationNote: note, updatedAt: new Date() })
    .where(eq(listings.serverId, serverId))
}

/** The materialized read model (§15.3). Says whether anything changed, for the owner's pages. */
export async function saveEligibility(
  q: Queryable,
  serverId: string,
  evaluated: { eligible: boolean; reasons: IneligibleReasonJson[]; revisionId: string | null; at: Date },
): Promise<boolean> {
  const before = await loadListing(q, serverId)
  if (before === null) return false
  await q
    .update(listings)
    .set({
      eligible: evaluated.eligible,
      ineligibleReasons: evaluated.reasons,
      evaluatedRevisionId: evaluated.revisionId,
      evaluatedAt: evaluated.at,
    })
    .where(eq(listings.serverId, serverId))
  return (
    before.eligible !== evaluated.eligible ||
    JSON.stringify(before.ineligibleReasons) !== JSON.stringify(evaluated.reasons)
  )
}

/** Every listing's server, for the daily rebuild. */
export async function listedServers(q: Queryable): Promise<string[]> {
  return (await q.select({ serverId: listings.serverId }).from(listings)).map((r) => r.serverId)
}

/** An account's servers that have a listing: standing and plan changes re-evaluate them. */
export async function listingsOfOwner(q: Queryable, ownerId: string): Promise<string[]> {
  const rows = await q
    .select({ serverId: listings.serverId })
    .from(listings)
    .innerJoin(servers, eq(servers.id, listings.serverId))
    .where(eq(servers.ownerId, ownerId))
  return rows.map((r) => r.serverId)
}

/**
 * Listed servers whose applied revision pins this catalog project, or this version: the ones a
 * catalog transition or an allowlist change can move (§15.3, served by the index on mods).
 */
export async function listedPinning(
  q: Queryable,
  pin: { catalog: string; projectId?: string; versionId?: string },
): Promise<string[]> {
  const source = {
    catalog: pin.catalog,
    ...(pin.projectId ? { projectId: pin.projectId } : {}),
    ...(pin.versionId ? { versionId: pin.versionId } : {}),
  }
  const rows = await q
    .select({ serverId: listings.serverId })
    .from(listings)
    .innerJoin(runtimes, eq(runtimes.serverId, listings.serverId))
    .innerJoin(revisions, sql`${revisions.id} = (${runtimes.applied} ->> 'revisionId')::uuid`)
    .where(sql`${revisions.mods} @> ${JSON.stringify([{ source }])}::jsonb`)
  return rows.map((r) => r.serverId)
}

// ─── The directory ──────────────────────────────────────────────────────────────────────────

export interface DirectoryRow {
  listing: ListingRecord
  server: {
    id: string
    name: string
    description: string
    icon: string | null
    tags: string[]
    slug: string
    status: string
    ownerId: string
  }
  revisionId: string | null
  whitelistEnabled: boolean
  online: number
  lastPlayedAt: Date | null
  stars: number
  notes: number
  /** The person reading starred it; false when nobody is signed in. */
  starred: boolean
}

/**
 * Listings visible to everyone: published, clear, eligible, on a server that isn't deleted.
 * One indexed filter (`listings_browse`), newest change first.
 */
export async function directory(
  q: Queryable,
  query: {
    search: string
    tag: string | null
    onlineNow?: boolean
    kind?: 'any' | 'vanilla' | 'modded'
    offset: number
    limit: number
    serverId?: string
    slug?: string
    /** Who is reading, for the stars they set. */
    viewerId?: string | null
  },
): Promise<{ rows: DirectoryRow[]; total: number }> {
  const text = query.search.trim()
  const where = and(
    eq(listings.visibility, 'published'),
    eq(listings.moderation, 'clear'),
    eq(listings.eligible, true),
    isNull(servers.deletedAt),
    ...(query.serverId ? [eq(listings.serverId, query.serverId)] : []),
    ...(query.slug ? [eq(servers.slug, query.slug)] : []),
    ...(text ? [or(ilike(servers.name, `%${text}%`), ilike(servers.description, `%${text}%`))] : []),
    ...(query.tag ? [sql`${query.tag} = any(${servers.tags})`] : []),
    ...(query.onlineNow
      ? [sql`exists (select 1 from ${schema.serverPresence} p where p.server_id = ${servers.id})`]
      : []),
    // What it runs is what it last booted. The filter reaches the revision through the server
    // alone, since the count and the rows share this clause and only the rows join the runtime.
    ...(query.kind === 'modded' || query.kind === 'vanilla'
      ? [
          sql`exists (select 1 from ${runtimes} rt join ${revisions} r on r.id = (rt.applied ->> 'revisionId')::uuid
              where rt.server_id = ${servers.id} and jsonb_array_length(r.mods) ${query.kind === 'modded' ? sql.raw('> 0') : sql.raw('= 0')})`,
        ]
      : []),
  )
  const [counted] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(listings)
    .innerJoin(servers, eq(servers.id, listings.serverId))
    .where(where)
  const rows = await q
    .select({
      listing: listings,
      server: {
        id: servers.id,
        name: servers.name,
        description: servers.description,
        icon: servers.icon,
        tags: servers.tags,
        slug: servers.slug,
        status: servers.status,
        ownerId: servers.ownerId,
      },
      applied: runtimes.applied,
      whitelistEnabled: schema.serverAccess.whitelistEnabled,
      online: sql<number>`(select count(*)::int from ${schema.serverPresence} where ${schema.serverPresence.serverId} = ${servers.id})`,
      lastPlayedAt: schema.serverActivity.lastPlayerAt,
      stars: sql<number>`(select count(*)::int from ${schema.serverStars} where ${schema.serverStars.serverId} = ${servers.id})`,
      notes: sql<number>`(select count(*)::int from ${schema.serverNotes} where ${schema.serverNotes.serverId} = ${servers.id})`,
      starred: query.viewerId
        ? sql<boolean>`exists (select 1 from ${schema.serverStars} where ${schema.serverStars.serverId} = ${servers.id} and ${schema.serverStars.userId} = ${query.viewerId})`
        : sql<boolean>`false`,
    })
    .from(listings)
    .innerJoin(servers, eq(servers.id, listings.serverId))
    .leftJoin(runtimes, eq(runtimes.serverId, servers.id))
    .leftJoin(schema.serverAccess, eq(schema.serverAccess.serverId, servers.id))
    .leftJoin(schema.serverActivity, eq(schema.serverActivity.serverId, servers.id))
    .where(where)
    // Who is playing comes first, then what was played most recently: a directory reads best
    // when the servers someone can join right now are at the top.
    .orderBy(
      desc(sql`(select count(*) from ${schema.serverPresence} where server_id = ${servers.id})`),
      desc(sql`coalesce(${schema.serverActivity.lastPlayerAt}, ${listings.updatedAt})`),
    )
    .offset(query.offset)
    .limit(query.limit)
  return {
    total: counted?.n ?? 0,
    rows: rows.map((row) => ({
      listing: row.listing,
      server: row.server,
      revisionId: row.applied?.revisionId ?? null,
      whitelistEnabled: row.whitelistEnabled ?? false,
      online: Number(row.online),
      lastPlayedAt: row.lastPlayedAt,
      stars: Number(row.stars),
      notes: Number(row.notes),
      starred: row.starred,
    })),
  }
}

/** Listings an admin took out of the directory, newest decision first. */
export async function removedListings(q: Queryable): Promise<ListingRecord[]> {
  return q.select().from(listings).where(eq(listings.moderation, 'removed')).orderBy(desc(listings.updatedAt))
}

// ─── Reports ────────────────────────────────────────────────────────────────────────────────

export interface ReportRecord {
  id: string
  serverId: string
  reporterId: string
  reason: string
  status: 'open' | 'dismissed' | 'actioned'
  createdAt: Date
}

export async function insertReport(
  q: Queryable,
  report: { serverId: string; reporterId: string; reason: string },
): Promise<void> {
  await q.insert(reports).values(report)
}

export async function openReportBy(q: Queryable, serverId: string, reporterId: string): Promise<boolean> {
  const [row] = await q
    .select({ id: reports.id })
    .from(reports)
    .where(
      and(eq(reports.serverId, serverId), eq(reports.reporterId, reporterId), eq(reports.status, 'open')),
    )
  return row !== undefined
}

export async function loadReport(q: Queryable, id: string): Promise<ReportRecord | null> {
  const [row] = await q.select().from(reports).where(eq(reports.id, id))
  return row ?? null
}

export async function openReports(q: Queryable): Promise<ReportRecord[]> {
  return q.select().from(reports).where(eq(reports.status, 'open')).orderBy(desc(reports.createdAt))
}

/** Settles reports: every open one about a listing, or just one. */
export async function settleReports(
  tx: Tx,
  where: { serverId: string } | { id: string },
  status: 'dismissed' | 'actioned',
): Promise<void> {
  await tx
    .update(reports)
    .set({ status })
    .where(
      and(
        eq(reports.status, 'open'),
        'id' in where ? eq(reports.id, where.id) : eq(reports.serverId, where.serverId),
      ),
    )
}

// ─── The allowlist ──────────────────────────────────────────────────────────────────────────

export interface TrustedProject {
  catalog: string
  projectId: string
  displayName: string
  addedBy: string
  note: string | null
  createdAt: Date
}

export async function allowlist(q: Queryable): Promise<TrustedProject[]> {
  return q.select().from(trusted).orderBy(trusted.displayName)
}

export async function allowlisted(q: Queryable): Promise<Set<string>> {
  const rows = await q.select({ catalog: trusted.catalog, projectId: trusted.projectId }).from(trusted)
  return new Set(rows.map((r) => `${r.catalog}:${r.projectId}`))
}

export async function trustProject(q: Queryable, project: Omit<TrustedProject, 'createdAt'>): Promise<void> {
  await q
    .insert(trusted)
    .values(project)
    .onConflictDoUpdate({
      target: [trusted.catalog, trusted.projectId],
      set: { displayName: project.displayName, note: project.note, addedBy: project.addedBy },
    })
}

export async function untrustProject(q: Queryable, catalog: string, projectId: string): Promise<void> {
  await q.delete(trusted).where(and(eq(trusted.catalog, catalog), eq(trusted.projectId, projectId)))
}

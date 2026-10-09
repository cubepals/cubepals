import { type AppliedConfigJson, type ObservedJson, type Queryable, schema, type Tx } from '@blockly/db'
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, max, ne, sql } from 'drizzle-orm'
import type { RevisionDraft, ServerRevision } from '../../domain/revision/revision.ts'
import type { Lifecycle } from '../../domain/server/lifecycle.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { isMemoryTier } from '../../domain/server/size.ts'
import type { Slug } from '../../domain/server/slug.ts'
import type { World } from '../../domain/world/world.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'

const servers = schema.minecraftServers
const revisions = schema.serverRevisions
const worlds = schema.worlds
const runtimes = schema.serverRuntimes

type ServerRow = typeof servers.$inferSelect

function toServer(row: ServerRow): MinecraftServer {
  if (!isMemoryTier(row.memoryTier))
    throw new Error(`Server ${row.id} has an unknown memory tier ${row.memoryTier}`)
  if (row.desiredRevisionId === null || row.activeWorldId === null)
    throw new Error(`Server ${row.id} was saved without its revision or world`)
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description,
    icon: row.icon,
    tags: row.tags,
    slug: row.slug as Slug,
    inviteCode: row.inviteCode,
    regionKey: row.regionKey,
    memoryTier: row.memoryTier,
    lifecycle: {
      status: row.status,
      stopReason: row.stopReason,
      failure: row.failure
        ? {
            during: row.failure.during as NonNullable<Lifecycle['failure']>['during'],
            message: row.failure.message,
            operationId: row.failure.operationId,
            ...(row.failure.remedy === undefined ? {} : { remedy: row.failure.remedy }),
          }
        : null,
    },
    desiredRevisionId: row.desiredRevisionId,
    activeWorldId: row.activeWorldId,
    version: row.version,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastActiveAt: row.lastActiveAt,
    storedAt: row.storedAt,
    deletedAt: row.deletedAt,
    purgeAfter: row.purgeAfter,
  }
}

export async function findServer(q: Queryable, id: string): Promise<MinecraftServer | null> {
  const [row] = await q.select().from(servers).where(eq(servers.id, id))
  return row ? toServer(row) : null
}

/** Reads and row-locks a server for the rest of the transaction: one writer at a time. */
export async function lockServer(tx: Tx, id: string): Promise<MinecraftServer | null> {
  const [row] = await tx.select().from(servers).where(eq(servers.id, id)).for('update')
  return row ? toServer(row) : null
}

export async function findByCreateKey(
  q: Queryable,
  ownerId: string,
  key: string,
): Promise<MinecraftServer | null> {
  const [row] = await q
    .select()
    .from(servers)
    .where(and(eq(servers.ownerId, ownerId), eq(servers.createIdempotencyKey, key)))
  return row ? toServer(row) : null
}

export async function findLiveBySlug(q: Queryable, slug: string): Promise<MinecraftServer | null> {
  const [row] = await q
    .select()
    .from(servers)
    .where(and(eq(servers.slug, slug), isNull(servers.deletedAt)))
  return row ? toServer(row) : null
}

/** The server an invite link points at, while it is live. */
export async function findByInvite(q: Queryable, code: string): Promise<MinecraftServer | null> {
  const [row] = await q
    .select()
    .from(servers)
    .where(and(eq(servers.inviteCode, code), isNull(servers.deletedAt)))
  return row ? toServer(row) : null
}

/** Whether a deleted server, not yet purged, still holds this address. */
export async function heldByDeleted(q: Queryable, slug: string): Promise<boolean> {
  const [row] = await q
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.slug, slug), eq(servers.status, 'deleted')))
  return row !== undefined
}

export async function listOwned(q: Queryable, ownerId: string): Promise<MinecraftServer[]> {
  const rows = await q
    .select()
    .from(servers)
    .where(and(eq(servers.ownerId, ownerId), isNull(servers.deletedAt)))
    .orderBy(desc(servers.createdAt))
  return rows.map(toServer)
}

/** How many live servers an account has: enough to know whether this is its first. */
export async function countLive(q: Queryable, ownerId: string): Promise<number> {
  const [row] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(servers)
    .where(and(eq(servers.ownerId, ownerId), isNull(servers.deletedAt)))
  return row?.n ?? 0
}

/** Every server an account has that isn't purged, the ones in its trash too. */
export async function listUnpurged(q: Queryable, ownerId: string): Promise<MinecraftServer[]> {
  const rows = await q
    .select()
    .from(servers)
    .where(and(eq(servers.ownerId, ownerId), ne(servers.status, 'purged')))
    .orderBy(desc(servers.createdAt))
  return rows.map(toServer)
}

/** An account's trash: servers deleted and not yet purged, the soonest to go first. */
export async function listTrashed(q: Queryable, ownerId: string): Promise<MinecraftServer[]> {
  const rows = await q
    .select()
    .from(servers)
    .where(and(eq(servers.ownerId, ownerId), eq(servers.status, 'deleted')))
    .orderBy(asc(servers.purgeAfter))
  return rows.map(toServer)
}

/**
 * An owner's purged servers whose archives are still kept (§15.4: archives survive purge), with
 * how many and until when the last of them is kept.
 */
export async function purgedWithArchives(
  q: Queryable,
  ownerId: string,
): Promise<Array<{ id: string; name: string; archives: number; keptUntil: Date | null }>> {
  const backups = schema.backups
  const rows = await q
    .select({
      id: servers.id,
      name: servers.name,
      archives: sql<number>`count(${backups.id})::int`,
      keptUntil: sql<Date | null>`max(${backups.expiresAt})`,
    })
    .from(servers)
    .innerJoin(backups, eq(backups.serverId, servers.id))
    .where(
      and(
        eq(servers.ownerId, ownerId),
        eq(servers.status, 'purged'),
        eq(backups.tier, 'archive'),
        eq(backups.status, 'ready'),
      ),
    )
    .groupBy(servers.id, servers.name)
    .orderBy(asc(servers.name))
  return rows.map((r) => ({ ...r, keptUntil: r.keptUntil === null ? null : new Date(r.keptUntil) }))
}

/** Ready backups per server and tier. */
export async function readyBackupCounts(
  q: Queryable,
  serverIds: readonly string[],
): Promise<Map<string, { snapshots: number; archives: number }>> {
  const counts = new Map(serverIds.map((id) => [id, { snapshots: 0, archives: 0 }]))
  if (serverIds.length === 0) return counts
  const rows = await q
    .select({ serverId: schema.backups.serverId, tier: schema.backups.tier, n: count() })
    .from(schema.backups)
    .where(and(inArray(schema.backups.serverId, [...serverIds]), eq(schema.backups.status, 'ready')))
    .groupBy(schema.backups.serverId, schema.backups.tier)
  for (const row of rows) {
    const entry = counts.get(row.serverId)
    if (entry) entry[row.tier === 'snapshot' ? 'snapshots' : 'archives'] = row.n
  }
  return counts
}

export async function listLive(q: Queryable): Promise<MinecraftServer[]> {
  return (await q.select().from(servers).where(isNull(servers.deletedAt))).map(toServer)
}

/**
 * Someone played, or its owner started it. Presence reads every minute, so `everyMinutes` keeps
 * that to a write now and then; an owner's own start writes at once.
 */
export async function markActive(q: Queryable, serverId: string, at: Date, everyMinutes = 0): Promise<void> {
  await q
    .update(servers)
    .set({ lastActiveAt: at })
    .where(
      and(eq(servers.id, serverId), lt(servers.lastActiveAt, new Date(at.getTime() - everyMinutes * 60_000))),
    )
}

/** When its world was stored away, or null once it has storage of its own again. */
export async function markStored(q: Queryable, serverId: string, at: Date | null): Promise<void> {
  await q.update(servers).set({ storedAt: at }).where(eq(servers.id, serverId))
}

/** Servers asleep or resting that nobody has played since `before`, longest first. */
export async function unplayedSince(q: Queryable, before: Date, limit: number): Promise<MinecraftServer[]> {
  const rows = await q
    .select()
    .from(servers)
    .where(
      and(
        inArray(servers.status, ['stopped', 'stored']),
        isNull(servers.deletedAt),
        lt(servers.lastActiveAt, before),
      ),
    )
    .orderBy(asc(servers.lastActiveAt))
    .limit(limit)
  return rows.map(toServer)
}

/** The warnings sent before a world goes for being unplayed; see `deletion_warned`. */
export async function deletionWarned(q: Queryable, serverId: string): Promise<string | null> {
  const [row] = await q
    .select({ warned: servers.deletionWarned })
    .from(servers)
    .where(eq(servers.id, serverId))
  return row?.warned ?? null
}

export async function saveDeletionWarned(
  q: Queryable,
  serverId: string,
  warned: string | null,
): Promise<void> {
  await q.update(servers).set({ deletionWarned: warned }).where(eq(servers.id, serverId))
}

/** Stopped servers nobody has played since `before`, longest idle first: what may rest. */
export async function idleSince(q: Queryable, before: Date, limit: number): Promise<MinecraftServer[]> {
  const rows = await q
    .select()
    .from(servers)
    .where(and(eq(servers.status, 'stopped'), isNull(servers.deletedAt), lt(servers.lastActiveAt, before)))
    .orderBy(asc(servers.lastActiveAt))
    .limit(limit)
  return rows.map(toServer)
}

export async function listByStatus(q: Queryable, status: Lifecycle['status']): Promise<MinecraftServer[]> {
  return (await q.select().from(servers).where(eq(servers.status, status))).map(toServer)
}

/**
 * Free for a new server: no live server holds it, and it is not in quarantine, unless
 * `serverId` itself retired it; a server may take its own old address back.
 */
export async function slugAvailable(
  q: Queryable,
  slug: string,
  now: Date,
  serverId?: string,
): Promise<boolean> {
  const [live] = await q
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.slug, slug), isNull(servers.deletedAt)))
  if (live) return false
  const [retired] = await q
    .select({ slug: schema.retiredSlugs.slug, serverId: schema.retiredSlugs.serverId })
    .from(schema.retiredSlugs)
    .where(and(eq(schema.retiredSlugs.slug, slug), gt(schema.retiredSlugs.availableAfter, now)))
  return retired === undefined || retired.serverId === serverId
}

/** How long a retired address stays out of reach (§19.1): longer for one the directory listed. */
const SLUG_QUARANTINE_DAYS = { unlisted: 30, listed: 180 } as const

/**
 * A server's address leaves it: quarantined, so nobody else can claim it and receive its
 * players. A server the directory listed was found by strangers, so its address rests longer.
 */
export async function retireSlug(tx: Tx, server: MinecraftServer, now: Date): Promise<void> {
  const [listing] = await tx
    .select({ visibility: schema.publicListings.visibility })
    .from(schema.publicListings)
    .where(eq(schema.publicListings.serverId, server.id))
  const days =
    listing?.visibility === 'published' ? SLUG_QUARANTINE_DAYS.listed : SLUG_QUARANTINE_DAYS.unlisted
  const availableAfter = new Date(now.getTime() + days * 86_400_000)
  await tx
    .insert(schema.retiredSlugs)
    .values({ slug: server.slug, serverId: server.id, retiredAt: now, availableAfter })
    .onConflictDoUpdate({
      target: schema.retiredSlugs.slug,
      set: { serverId: server.id, retiredAt: now, availableAfter },
    })
}

export interface NewServer {
  ownerId: string
  name: string
  slug: Slug
  /** The secret half of the server's invite link, made when the server is. */
  inviteCode: string
  regionKey: string
  memoryTier: string
  createIdempotencyKey: string
  /** How it was made, for knowing which ways to start people use. */
  createdFrom: 'template' | 'curated' | 'modpack' | 'upload' | 'copy' | 'invite' | 'direct'
  /** Set for a server made for a while; Blockly deletes it then. */
  expiresAt?: Date | null
}

/**
 * Inserts the server with its first revision and world in one transaction. The row and its
 * children reference each other, so the pointers are set last; no other reader can see the
 * server before they are.
 */
export async function insertServer(
  tx: Tx,
  input: NewServer,
  revision: RevisionDraft & { createdBy: string },
  world: Omit<World, 'id' | 'serverId'>,
): Promise<{ server: MinecraftServer; revision: ServerRevision; world: World }> {
  const serverId = crypto.randomUUID()
  const revisionId = crypto.randomUUID()
  const worldId = crypto.randomUUID()

  await tx.insert(servers).values({ id: serverId, ...input, status: 'provisioning' })
  await tx.insert(revisions).values({
    id: revisionId,
    serverId,
    number: 1,
    gameVersion: revision.gameVersion,
    loader: revision.loader,
    loaderVersion: revision.loaderVersion,
    settings: revision.settings,
    mods: revision.mods,
    modpack: revision.modpack,
    files: revision.files,
    reason: revision.reason,
    basedOnRevisionId: revision.basedOnRevisionId,
    createdBy: revision.createdBy,
  })
  await tx.insert(worlds).values({ id: worldId, serverId, ...world })
  await tx
    .update(servers)
    .set({ desiredRevisionId: revisionId, activeWorldId: worldId })
    .where(eq(servers.id, serverId))

  const server = await findServer(tx, serverId)
  if (server === null) throw new Error('The server just inserted is missing')
  return {
    server,
    revision: { ...revision, id: revisionId, serverId, number: 1 },
    world: { ...world, id: worldId, serverId },
  }
}

/** Writes a new lifecycle and bumps the version; the caller has decided the transition. */
export async function saveLifecycle(
  tx: Tx,
  server: MinecraftServer,
  lifecycle: Lifecycle,
): Promise<MinecraftServer> {
  const [row] = await tx
    .update(servers)
    .set({
      status: lifecycle.status,
      stopReason: lifecycle.stopReason,
      failure: lifecycle.failure,
      version: sql`${servers.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(servers.id, server.id))
    .returning()
  if (!row) throw new Error(`Server ${server.id} vanished while being saved`)
  return toServer(row)
}

/** Deletion's dates, written with the transition to `deleted` that already bumped the version. */
export async function markDeleted(
  tx: Tx,
  server: MinecraftServer,
  now: Date,
  purgeAfter: Date,
): Promise<void> {
  await tx
    .update(servers)
    .set({ deletedAt: now, purgeAfter, updatedAt: now })
    .where(eq(servers.id, server.id))
}

/** A deleted server's purge brought forward: a change of its own, so the version moves with it. */
export async function purgeSooner(
  tx: Tx,
  server: MinecraftServer,
  purgeAfter: Date,
): Promise<MinecraftServer> {
  const [row] = await tx
    .update(servers)
    .set({ purgeAfter, version: sql`${servers.version} + 1`, updatedAt: new Date() })
    .where(eq(servers.id, server.id))
    .returning()
  if (!row) throw new Error(`Server ${server.id} vanished while being saved`)
  return toServer(row)
}

export async function markUndeleted(tx: Tx, server: MinecraftServer): Promise<void> {
  await tx
    .update(servers)
    .set({ deletedAt: null, purgeAfter: null, updatedAt: new Date() })
    .where(eq(servers.id, server.id))
}

// ─── Revisions and worlds ───────────────────────────────────────────────────────────────────

type RevisionRow = typeof revisions.$inferSelect

function toRevision(row: RevisionRow): ServerRevision {
  return {
    id: row.id,
    serverId: row.serverId,
    number: row.number,
    gameVersion: row.gameVersion,
    loader: row.loader,
    loaderVersion: row.loaderVersion,
    settings: row.settings,
    mods: row.mods,
    modpack: row.modpack === null ? null : { environment: 'both', icon: null, ...row.modpack },
    files: row.files,
    acknowledgedRevoked: row.acknowledgedRevoked,
    reason: row.reason as ServerRevision['reason'],
    basedOnRevisionId: row.basedOnRevisionId,
    createdBy: row.createdBy,
  }
}

export async function loadRevision(q: Queryable, id: string): Promise<ServerRevision> {
  const [row] = await q.select().from(revisions).where(eq(revisions.id, id))
  if (!row) throw new Error(`Revision ${id} is missing`)
  return toRevision(row)
}

/** Revisions are never edited; every change is a new one, numbered after the latest. */
export async function insertRevision(
  tx: Tx,
  serverId: string,
  draft: RevisionDraft,
  createdBy: string,
): Promise<ServerRevision> {
  const number = await nextRevisionNumber(tx, serverId)
  const [row] = await tx
    .insert(revisions)
    .values({
      serverId,
      number,
      gameVersion: draft.gameVersion,
      loader: draft.loader,
      loaderVersion: draft.loaderVersion,
      settings: draft.settings,
      mods: draft.mods,
      modpack: draft.modpack,
      files: draft.files,
      acknowledgedRevoked: draft.acknowledgedRevoked,
      reason: draft.reason,
      basedOnRevisionId: draft.basedOnRevisionId,
      createdBy,
    })
    .returning()
  if (!row) throw new Error('The revision just inserted is missing')
  return toRevision(row)
}

/** A server's revisions, newest first, with when each was made. */
export async function listRevisions(
  q: Queryable,
  serverId: string,
  limit: number,
): Promise<Array<ServerRevision & { createdAt: Date }>> {
  const rows = await q
    .select()
    .from(revisions)
    .where(eq(revisions.serverId, serverId))
    .orderBy(desc(revisions.number))
    .limit(limit)
  return rows.map((row) => ({ ...toRevision(row), createdAt: row.createdAt }))
}

/**
 * Moves what the server should run: its revision, size or world. What runs moves only when an
 * operation boots it (`saveApplied`).
 */
export async function setDesired(
  tx: Tx,
  server: MinecraftServer,
  change: {
    revisionId?: string
    memoryTier?: MinecraftServer['memoryTier']
    activeWorldId?: string
    regionKey?: string
  },
): Promise<MinecraftServer> {
  const [row] = await tx
    .update(servers)
    .set({
      ...(change.revisionId === undefined ? {} : { desiredRevisionId: change.revisionId }),
      ...(change.memoryTier === undefined ? {} : { memoryTier: change.memoryTier }),
      ...(change.activeWorldId === undefined ? {} : { activeWorldId: change.activeWorldId }),
      ...(change.regionKey === undefined ? {} : { regionKey: change.regionKey }),
      version: sql`${servers.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(servers.id, server.id))
    .returning()
  if (!row) throw new Error(`Server ${server.id} vanished while being saved`)
  return toServer(row)
}

/** A new name, or a new address; the caller has checked and retired what it replaces. */
export async function saveIdentity(
  tx: Tx,
  server: MinecraftServer,
  change: {
    name?: string
    description?: string
    icon?: string | null
    tags?: readonly string[]
    slug?: string
    inviteCode?: string
    /** Null keeps a server that was made for a while. */
    expiresAt?: Date | null
  },
): Promise<MinecraftServer> {
  const [row] = await tx
    .update(servers)
    .set({
      ...(change.name === undefined ? {} : { name: change.name }),
      ...(change.description === undefined ? {} : { description: change.description }),
      ...(change.icon === undefined ? {} : { icon: change.icon }),
      ...(change.tags === undefined ? {} : { tags: [...change.tags] }),
      ...(change.inviteCode === undefined ? {} : { inviteCode: change.inviteCode }),
      ...(change.slug === undefined ? {} : { slug: change.slug }),
      ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
      version: sql`${servers.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(servers.id, server.id))
    .returning()
  if (!row) throw new Error(`Server ${server.id} vanished while being saved`)
  return toServer(row)
}

async function nextRevisionNumber(tx: Tx, serverId: string): Promise<number> {
  const [row] = await tx
    .select({ n: max(revisions.number) })
    .from(revisions)
    .where(eq(revisions.serverId, serverId))
  return (row?.n ?? 0) + 1
}

export async function loadWorld(q: Queryable, id: string): Promise<World> {
  const [row] = await q.select().from(worlds).where(eq(worlds.id, id))
  if (!row) throw new Error(`World ${id} is missing`)
  return row
}

// ─── Runtime binding ────────────────────────────────────────────────────────────────────────

export interface RuntimeBinding {
  serverId: string
  provider: string
  /** Null until the first resource exists, and for a binding another provider issued. */
  handle: RuntimeHandle | null
  /**
   * Issued by a provider this deployment doesn't run, as when a local control plane points at a
   * copy of staging data. Its handle is withheld, so no adapter is ever fed another's handle.
   */
  foreign: boolean
  placementRegionKey: string | null
  applied: AppliedConfigJson | null
  observed: ObservedJson | null
  /** The runtime an operator asked it to move to, until it has (docs/runtimes.md). */
  moveTo: string | null
}

export async function createRuntimeBinding(tx: Tx, serverId: string, provider: string): Promise<void> {
  await tx.insert(runtimes).values({ serverId, provider }).onConflictDoNothing()
}

/** `providers` are the runtimes this deployment runs; a binding to any other is foreign. */
export async function loadRuntime(
  q: Queryable,
  serverId: string,
  providers: readonly string[],
): Promise<RuntimeBinding> {
  const [row] = await q.select().from(runtimes).where(eq(runtimes.serverId, serverId))
  if (!row) throw new Error(`Server ${serverId} has no runtime binding`)
  const foreign = !providers.includes(row.provider)
  return { ...row, handle: foreign ? null : (row.handle as RuntimeHandle | null), foreign }
}

/** The disk a server's world has grown into, in GB; 0 until it outgrew its plan's. */
export async function grownStorage(q: Queryable, serverId: string): Promise<number> {
  const [row] = await q
    .select({ gb: runtimes.storageGb })
    .from(runtimes)
    .where(eq(runtimes.serverId, serverId))
  return row?.gb ?? 0
}

/** A bigger disk for the server's next start or restore, as a world brought back needs one. */
export async function growStorage(q: Queryable, serverId: string, gb: number): Promise<void> {
  await q.update(runtimes).set({ storageGb: gb }).where(eq(runtimes.serverId, serverId))
}

/**
 * What a server's world took on disk as it stopped; `grownTo`, when it is close to full and its
 * plan lets it grow, is the disk its next start gets.
 */
export async function recordDisk(
  q: Queryable,
  serverId: string,
  usedBytes: number,
  at: Date,
  grownTo?: number,
): Promise<void> {
  await q
    .update(runtimes)
    .set({
      diskUsedBytes: usedBytes,
      diskCheckedAt: at,
      ...(grownTo === undefined ? {} : { storageGb: grownTo }),
    })
    .where(eq(runtimes.serverId, serverId))
}

export async function saveHandle(
  q: Queryable,
  serverId: string,
  handle: RuntimeHandle | null,
  regionKey?: string,
): Promise<void> {
  await q
    .update(runtimes)
    .set({
      handle,
      ...(regionKey === undefined ? {} : { placementRegionKey: regionKey }),
      updatedAt: new Date(),
    })
    .where(eq(runtimes.serverId, serverId))
}

export async function saveApplied(q: Queryable, serverId: string, applied: AppliedConfigJson): Promise<void> {
  await q.update(runtimes).set({ applied, updatedAt: new Date() }).where(eq(runtimes.serverId, serverId))
}

/** The observed detail of a workload the provider says ran out of memory. */
export const OUT_OF_MEMORY = 'out of memory'
/** The observed detail of compute whose host the provider can't reach; `at` is when it was first seen. */
export const HOST_LOST = 'host lost'

export async function saveObserved(q: Queryable, serverId: string, observed: ObservedJson): Promise<void> {
  await q.update(runtimes).set({ observed, updatedAt: new Date() }).where(eq(runtimes.serverId, serverId))
}

/** Statuses in which a server holds compute, and so the secrets it booted with. */
const HOLDS_COMPUTE = ['starting', 'running', 'stopping', 'updating', 'restoring', 'relocating'] as const

/**
 * Servers holding compute that last booted on a runtime key older than `version`: until
 * none is left, the older keys must still be accepted. A stopped server boots on the current key.
 */
export async function onEarlierKeys(q: Queryable, version: number): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(runtimes)
    .innerJoin(servers, eq(servers.id, runtimes.serverId))
    .where(
      and(
        inArray(servers.status, [...HOLDS_COMPUTE]),
        sql`coalesce((${runtimes.applied}->>'secretsVersion')::int, 1) < ${version}`,
      ),
    )
  return row?.n ?? 0
}

/** The bindings to the runtimes this deployment runs; foreign ones are left out. */
export async function listBindings(q: Queryable, providers: readonly string[]): Promise<RuntimeBinding[]> {
  const rows = await q
    .select()
    .from(runtimes)
    .where(inArray(runtimes.provider, [...providers]))
  return rows.map((row) => ({ ...row, handle: row.handle as RuntimeHandle | null, foreign: false }))
}

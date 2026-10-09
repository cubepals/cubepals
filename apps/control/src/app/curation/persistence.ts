import { type CuratedFactsJson, type Queryable, schema } from '@blockly/db'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Distribution, ReleaseState } from '../../domain/mods/curation.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'

const releases = schema.curatedReleases

/** One curated release, as checking it left it (docs/modpack-templates.md § A release's life). */
export interface CuratedReleaseRecord {
  key: string
  version: string
  state: ReleaseState
  /** How servers get its files; null until it is verified. */
  distribution: Distribution | null
  /** The pack a server of it pins; null until it is verified. */
  pack: PinnedModpack | null
  facts: CuratedFactsJson | null
  refusal: string | null
  detail: string | null
  withdrawnReason: string | null
  changedBy: string
  createdAt: Date
  verifiedAt: Date | null
  publishedAt: Date | null
  withdrawnAt: Date | null
}

type Row = typeof releases.$inferSelect

function recordOf(row: Row): CuratedReleaseRecord {
  return {
    key: row.packKey,
    version: row.version,
    state: row.state,
    distribution: row.distribution,
    pack: row.pack === null ? null : { environment: 'both', icon: null, ...row.pack },
    facts: row.facts,
    refusal: row.refusal,
    detail: row.detail,
    withdrawnReason: row.withdrawnReason,
    changedBy: row.changedBy,
    createdAt: row.createdAt,
    verifiedAt: row.verifiedAt,
    publishedAt: row.publishedAt,
    withdrawnAt: row.withdrawnAt,
  }
}

export async function loadRelease(
  q: Queryable,
  key: string,
  version: string,
): Promise<CuratedReleaseRecord | null> {
  const [row] = await q
    .select()
    .from(releases)
    .where(and(eq(releases.packKey, key), eq(releases.version, version)))
  return row === undefined ? null : recordOf(row)
}

/** Every release of these packs Blockly has seen, or of every pack when none are named. */
export async function loadReleases(q: Queryable, keys?: readonly string[]): Promise<CuratedReleaseRecord[]> {
  const rows = await q
    .select()
    .from(releases)
    .where(
      keys === undefined ? undefined : keys.length === 0 ? sql`false` : inArray(releases.packKey, [...keys]),
    )
    .orderBy(asc(releases.packKey), asc(releases.createdAt))
  return rows.map(recordOf)
}

/** A reviewed release seen for the first time, waiting to be checked. Says whether it was new. */
export async function insertPending(q: Queryable, key: string, version: string): Promise<boolean> {
  const inserted = await q
    .insert(releases)
    .values({ packKey: key, version, state: 'pending' })
    .onConflictDoNothing()
    .returning({ key: releases.packKey })
  return inserted.length > 0
}

/**
 * What checking a release found, kept once: a release is verified from `pending` only, so two
 * checks racing can't write two different packs under one name. Says whether this one did.
 */
export async function releaseVerified(
  q: Queryable,
  key: string,
  version: string,
  verified: { distribution: Distribution; pack: PinnedModpack; facts: CuratedFactsJson; at: Date },
): Promise<boolean> {
  const updated = await q
    .update(releases)
    .set({
      state: 'verified',
      distribution: verified.distribution,
      pack: verified.pack,
      facts: verified.facts,
      refusal: null,
      detail: null,
      changedBy: 'system:curation',
      verifiedAt: verified.at,
      updatedAt: verified.at,
    })
    .where(and(eq(releases.packKey, key), eq(releases.version, version), eq(releases.state, 'pending')))
    .returning({ key: releases.packKey })
  return updated.length > 0
}

/** Why checking a release refused it, for an admin to act on. */
export async function releaseRefused(
  q: Queryable,
  key: string,
  version: string,
  refused: { refusal: string; detail: string; at: Date },
): Promise<boolean> {
  const updated = await q
    .update(releases)
    .set({
      state: 'refused',
      refusal: refused.refusal,
      detail: refused.detail,
      changedBy: 'system:curation',
      updatedAt: refused.at,
    })
    .where(and(eq(releases.packKey, key), eq(releases.version, version), eq(releases.state, 'pending')))
    .returning({ key: releases.packKey })
  return updated.length > 0
}

/**
 * A release moved from `from` to `to` by an admin or by the schedule, with what the move records.
 * Guarded by the state it was read in, so two admins acting at once move it once.
 */
export async function moveRelease(
  q: Queryable,
  key: string,
  version: string,
  move: {
    from: ReleaseState
    to: ReleaseState
    by: string
    at: Date
    withdrawnReason?: string | null
  },
): Promise<boolean> {
  const updated = await q
    .update(releases)
    .set({
      state: move.to,
      changedBy: move.by,
      updatedAt: move.at,
      ...(move.to === 'published' ? { publishedAt: move.at, withdrawnAt: null, withdrawnReason: null } : {}),
      ...(move.to === 'withdrawn'
        ? { withdrawnAt: move.at, withdrawnReason: move.withdrawnReason ?? null }
        : {}),
      ...(move.to === 'pending' ? { refusal: null, detail: null } : {}),
    })
    .where(and(eq(releases.packKey, key), eq(releases.version, version), eq(releases.state, move.from)))
    .returning({ key: releases.packKey })
  return updated.length > 0
}

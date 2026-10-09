/**
 * Blockly's cache of the mod catalogs and its trust in them: projects and versions as last read,
 * the refreshes that read them, checked and curated packs, and the projects trusted outright.
 * Joins counted per play domain live here too, beside the other things refreshed from outside.
 */
import { sql } from 'drizzle-orm'
import { check, integer, jsonb, pgEnum, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import type { CuratedFactsJson, PinnedModpackJson } from '../json.ts'
import { createdAt, ts, updatedAt } from './columns.ts'

// ─── Catalog cache and trust ────────────────────────────────────────────────────────────────

export const catalogProjects = pgTable(
  'catalog_projects',
  {
    catalog: text('catalog').notNull(),
    projectId: text('project_id').notNull(),
    state: text('state').notNull(),
    absentStreak: integer('absent_streak').notNull().default(0),
    fetchedAt: ts('fetched_at').notNull(),
    stateChangedAt: ts('state_changed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.catalog, t.projectId] })],
)

export const catalogVersions = pgTable(
  'catalog_versions',
  {
    catalog: text('catalog').notNull(),
    versionId: text('version_id').notNull(),
    projectId: text('project_id').notNull(),
    state: text('state').notNull(),
    absentStreak: integer('absent_streak').notNull().default(0),
    fetchedAt: ts('fetched_at').notNull(),
    stateChangedAt: ts('state_changed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.catalog, t.versionId] })],
)

/**
 * Joins the edge reported through each play domain: an alias kept for a domain move can be
 * dropped once nobody joins through it (§11).
 */
export const playDomainJoins = pgTable('play_domain_joins', {
  domain: text('domain').primaryKey(),
  joins: integer('joins').notNull().default(0),
  lastJoinAt: ts('last_join_at').notNull(),
})

/**
 * When each catalog last answered a full refresh. Staleness counts from here (§15.3), not from
 * whenever a cache row was written: mod planning writes rows too.
 */
export const catalogRefreshes = pgTable('catalog_refreshes', {
  catalog: text('catalog').primaryKey(),
  refreshedAt: ts('refreshed_at').notNull(),
  /**
   * When a refresh last asked and the catalog didn't answer. Old data alone isn't an alert: while
   * nothing ran, nothing was asked (§15.3).
   */
  failedAt: ts('failed_at'),
})

/**
 * What choosing a pack would be told, found before anybody chooses it (§15.6): the create page's
 * lists leave out, or dim with the reason, a pack Blockly can't run as a server. `refusal` is null
 * when it runs. Checked again as its packs publish new versions.
 */
export const packChecks = pgTable(
  'pack_checks',
  {
    catalog: text('catalog').notNull(),
    projectId: text('project_id').notNull(),
    refusal: text('refusal'),
    checkedAt: ts('checked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.catalog, t.projectId] })],
)

/** Where a curated release stands (docs/modpack-templates.md § A release's life). */
export const curatedReleaseState = pgEnum('curated_release_state', [
  'pending',
  'verified',
  'published',
  'withdrawn',
  'refused',
])

/**
 * One release of a pack Blockly offers by name, and what checking it found
 * (docs/modpack-templates.md). Which releases exist is reviewed code (`app/curation/packs.ts`);
 * what their bytes turned out to be, and whether they are offered, is kept here. Once a release is
 * verified its pack and facts never change: servers pin the pack, byte for byte.
 */
export const curatedReleases = pgTable(
  'curated_releases',
  {
    packKey: text('pack_key').notNull(),
    version: text('version').notNull(),
    state: curatedReleaseState('state').notNull().default('pending'),
    /** How servers get its files, once verified: from Blockly's copy, or from its authors. */
    distribution: text('distribution').$type<'mirror' | 'upstream'>(),
    /** The pack a server of it pins, once verified. */
    pack: jsonb('pack').$type<PinnedModpackJson>(),
    /** What checking it found: what it runs on, its size, its licences, where every byte came from. */
    facts: jsonb('facts').$type<CuratedFactsJson>(),
    /** Why it was refused, in a sentence an admin acts on; the detail behind it. */
    refusal: text('refusal'),
    detail: text('detail'),
    /** Why it stopped being offered to new servers. */
    withdrawnReason: text('withdrawn_reason'),
    /** Who moved it last: `system:curation`, or the admin who published or withdrew it. */
    changedBy: text('changed_by').notNull().default('system:curation'),
    createdAt: createdAt(),
    verifiedAt: ts('verified_at'),
    publishedAt: ts('published_at'),
    withdrawnAt: ts('withdrawn_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.packKey, t.version] }),
    // Nothing is offered or installed that wasn't checked: past `pending` and `refused` a release
    // always holds the pack servers pin, what was found, and how its files are handed out.
    check(
      'curated_releases_checked',
      sql`${t.state} in ('pending', 'refused') or (${t.pack} is not null and ${t.facts} is not null and ${t.distribution} is not null)`,
    ),
  ],
)

export const trustedModProjects = pgTable(
  'trusted_mod_projects',
  {
    catalog: text('catalog').notNull(),
    projectId: text('project_id').notNull(),
    displayName: text('display_name').notNull(),
    addedBy: text('added_by').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.catalog, t.projectId] })],
)

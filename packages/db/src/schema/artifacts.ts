/**
 * Files Blockly keeps and builds from: stored artifacts by hash, uploads in flight, uploaded mods,
 * and the packs read from them.
 */
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import type { PackImportJson, PackJarJson, PackLeftOutJson } from '../json.ts'
import { users } from './auth.ts'
import { createdAt, ts } from './columns.ts'
import { loader, minecraftServers } from './servers.ts'

/**
 * `built`: a pack Blockly wrote from an upload, in the one shape every pack is installed from.
 * `curated`: Blockly's own copy of a curated release, where its licences allow one
 * (docs/modpack-templates.md).
 */
export const artifactSource = pgEnum('artifact_source', ['upload', 'mirror', 'built', 'curated'])

export const storedArtifacts = pgTable('stored_artifacts', {
  sha512: text('sha512').primaryKey(),
  key: text('key').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  source: artifactSource('source').notNull(),
  verifiedAt: ts('verified_at').notNull(),
  createdAt: createdAt(),
})

export const uploadKind = pgEnum('upload_kind', ['mod', 'world', 'pack'])

/**
 * A browser upload that was handed a presigned PUT. The key is kept so an upload nobody
 * finished, or a staging copy left behind, is deleted from the store (`artifact-gc`).
 */
export const pendingUploads = pgTable(
  'pending_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    /** Null for a pack uploaded while a server is being made, before it exists. */
    serverId: uuid('server_id').references(() => minecraftServers.id),
    kind: uploadKind('kind').notNull(),
    key: text('key').notNull(),
    fileName: text('file_name').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** What the browser says the bytes hash to (mods); checked before anything is kept. */
    sha512: text('sha512'),
    /** Taken in; only the staging copy is left to delete. */
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [index('pending_uploads_created').on(t.createdAt)],
)

export const modUploads = pgTable('mod_uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id),
  sha512: text('sha512')
    .notNull()
    .references(() => storedArtifacts.sha512),
  fileName: text('file_name').notNull(),
  loaderMetadata: jsonb('loader_metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
})

/**
 * What a pack file holds, read once and kept by the file's sha512 (docs/modpack-system.md): what
 * it runs on, the jars a server installs from it, which it leaves to players' games and why, and
 * what its author says it needs. Every pack a server plays has one, from the catalog or built.
 */
export const packContents = pgTable('pack_contents', {
  sha512: text('sha512').primaryKey(),
  name: text('name').notNull(),
  versionLabel: text('version_label').notNull(),
  gameVersion: text('game_version').notNull(),
  loader: loader('loader').notNull(),
  loaderVersion: text('loader_version'),
  /** Whether players need the pack in their own game to join. */
  playersNeedIt: boolean('players_need_it').notNull(),
  /** The jars a server installs, with the bytes each should hold. */
  jars: jsonb('jars').$type<PackJarJson[]>().notNull(),
  /** What the server leaves out, and why, for the owner to see. */
  leftOut: jsonb('left_out').$type<PackLeftOutJson[]>().notNull(),
  /** The memory its author starts it with, in megabytes; null when it says nothing. */
  memoryMb: integer('memory_mb'),
  createdAt: createdAt(),
})

export const packImportStatus = pgEnum('pack_import_status', ['reading', 'ready', 'refused'])

/**
 * A pack someone uploaded, and what reading it found: the pack Blockly built from it, or the one
 * sentence that says why it can't run. Owned by the uploader; a server that plays it pins the
 * built pack, so the import can go once nothing does.
 */
export const packImports = pgTable(
  'pack_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    fileName: text('file_name').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    status: packImportStatus('status').notNull().default('reading'),
    /** Set once ready: the pack Blockly built, and what it holds. */
    packSha512: text('pack_sha512').references(() => storedArtifacts.sha512),
    result: jsonb('result').$type<PackImportJson>(),
    /** The sentence the owner reads when it can't run; the detail stays for admins. */
    refusal: text('refusal'),
    detail: text('detail'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('pack_imports_owner').on(t.ownerId, t.createdAt)],
)

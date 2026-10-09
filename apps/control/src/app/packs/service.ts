import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PackImportView, PackLinkView, PackUpdateView, PackVersionView } from '@blockly/contracts'
import { type Db, type PackImportJson, schema } from '@blockly/db'
import { and, count, eq, gt } from 'drizzle-orm'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import type { ServerRevision } from '../../domain/revision/revision.ts'
import { loaderOfPack, serverEnvironment } from '../../minecraft/mods.ts'
import { compareVersions, LOADER_LABELS, packRuns } from '../../minecraft/versions.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { recordStored } from '../artifacts/persistence.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import type { CurseForge } from '../ports/curseforge.ts'
import { HostileArchive, type PackArchives } from '../ports/formats.ts'
import type { JobQueue } from '../ports/jobs.ts'
import { findServer } from '../servers/persistence.ts'
import {
  deletePendingUpload,
  finishPendingUpload,
  insertPendingUpload,
  loadPendingUpload,
} from '../uploads/persistence.ts'
import type { PackBuilder } from './build.ts'
import {
  insertPackImport,
  loadPackImport,
  type PackImportRecord,
  packImportReady,
  packImportRefused,
  savePackContents,
} from './persistence.ts'

/**
 * Packs people bring (docs/modpack-system.md): a file dropped where a server is made or where a
 * server's pack is changed, a link pasted where packs are searched, and the versions a pack has.
 * Every one ends as a pack Blockly can install, or one sentence on why not.
 */

/** A pack file up to this size; ATM10's server files are 1.2 GB (2026-09-22). */
const MAX_PACK_BYTES = 4 * 1024 ** 3
const UPLOAD_LINK_SECONDS = 60 * 60
const READ_LINK_SECONDS = 60 * 60
/** How many packs an account may read in a day: enough to try a few, not to farm the store. */
const IMPORTS_A_DAY = 25

export class PackService {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #jobs: JobQueue
  readonly #builder: PackBuilder
  readonly #archives: PackArchives
  readonly #catalog: ModCatalog
  readonly #curseforge: CurseForge

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    capabilities: DeploymentCapabilities
    jobs: JobQueue
    builder: PackBuilder
    archives: PackArchives
    catalog: ModCatalog
    curseforge: CurseForge
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#jobs = deps.jobs
    this.#builder = deps.builder
    this.#archives = deps.archives
    this.#catalog = deps.catalog
    this.#curseforge = deps.curseforge
  }

  // ─── Uploads ───────────────────────────────────────────────────────────────────────────────

  /** A link the browser puts the pack at, signed for the size it said. */
  async beginUpload(
    actor: Actor & { kind: 'user' },
    file: { fileName: string; sizeBytes: number },
  ): Promise<{ ticket: string; url: string; headers: Record<string, string> }> {
    const fileName = packFileName(file.fileName)
    if (fileName === null)
      throw new AppError('invalid_upload', 'Drop the pack as the .zip or .mrpack file it came in.')
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > MAX_PACK_BYTES)
      throw new AppError('invalid_upload', 'This pack is bigger than Cubepals takes.')
    return this.#db.transaction(async (tx) => {
      await this.#policy.require(tx, actor.userId, { kind: 'upload_pack' })
      const [today] = await tx
        .select({ n: count() })
        .from(schema.packImports)
        .where(
          and(
            eq(schema.packImports.ownerId, actor.userId),
            gt(schema.packImports.createdAt, new Date(Date.now() - 86_400_000)),
          ),
        )
      if ((today?.n ?? 0) >= IMPORTS_A_DAY)
        throw new AppError('rate_limited', 'That’s a lot of packs for one day. Try again tomorrow.')
      const store = requireCapability(this.#caps, 'archives')
      const id = randomUUID()
      const key = store.newKey('pack_upload', { serverId: '', id })
      await insertPendingUpload(tx, {
        id,
        ownerId: actor.userId,
        serverId: null,
        kind: 'pack',
        key,
        fileName,
        sizeBytes: file.sizeBytes,
        sha512: null,
      })
      const target = await store.presignPut(key, UPLOAD_LINK_SECONDS, 'browser', file.sizeBytes)
      return { ticket: id, url: target.url, headers: target.headers }
    })
  }

  /** The pack arrived: it is read and built off the request, and its import says when it's ready. */
  async finishUpload(actor: Actor & { kind: 'user' }, ticket: string): Promise<{ importId: string }> {
    const pending = await loadPendingUpload(this.#db, ticket)
    if (
      pending === null ||
      pending.kind !== 'pack' ||
      pending.ownerId !== actor.userId ||
      pending.finishedAt !== null
    )
      throw new NotFound('Upload')
    const store = requireCapability(this.#caps, 'archives')
    const arrived = await store.head(pending.key)
    if (arrived === null) throw new AppError('invalid_upload', 'The file never arrived. Upload it again.')
    if (arrived.sizeBytes !== pending.sizeBytes)
      throw new AppError('invalid_upload', 'The file didn’t arrive whole. Upload it again.')
    await this.#db.transaction(async (tx) => {
      await insertPackImport(tx, {
        id: pending.id,
        ownerId: pending.ownerId,
        fileName: pending.fileName,
        sizeBytes: pending.sizeBytes,
      })
      await finishPendingUpload(tx, pending.id, new Date())
      await this.#jobs.enqueuePackImport(tx, pending.id)
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'packs.uploaded',
        subjectType: 'user',
        subjectId: actor.userId,
        data: { importId: pending.id, fileName: pending.fileName, sizeBytes: pending.sizeBytes },
      })
    })
    return { importId: pending.id }
  }

  /** An import, as its owner sees it: still reading, ready with what it is, or refused and why. */
  async view(actor: Actor & { kind: 'user' }, importId: string): Promise<PackImportView> {
    const record = await this.#owned(actor, importId)
    const base = { importId: record.id, fileName: record.fileName }
    if (record.status === 'reading') return { status: 'reading', ...base }
    if (record.status === 'refused' || record.result === null)
      return { status: 'refused', ...base, message: record.refusal ?? 'Cubepals couldn’t read this pack.' }
    const result = record.result
    return {
      status: 'ready',
      ...base,
      pack: {
        name: result.name,
        version: result.versionLabel,
        gameVersion: result.gameVersion,
        loaderLabel: LOADER_LABELS[result.loader as keyof typeof LOADER_LABELS] ?? result.loader,
        mods: result.mods,
        playersNeedIt: result.playersNeedIt,
        notes: result.notes,
      },
    }
  }

  /**
   * `pack-import`: the uploaded file read and built into a pack, once. The upload is fetched to
   * this machine, opened as hostile input and never run; the staging copy goes afterwards,
   * whatever happened.
   */
  async runImport(importId: string): Promise<void> {
    const record = await loadPackImport(this.#db, importId)
    if (record === null || record.status !== 'reading') return
    const pending = await loadPendingUpload(this.#db, importId)
    const store = requireCapability(this.#caps, 'archives')
    const work = await mkdtemp(join(tmpdir(), 'blockly-pack-'))
    try {
      if (pending === null)
        throw new ImportFailed('The file never arrived. Upload it again.', 'no pending upload')
      const link = await store.presignGet(pending.key, READ_LINK_SECONDS, 'browser')
      const upload = join(work, 'upload')
      const arrived = await this.#archives
        .fetchTo(link.url, upload, pending.sizeBytes)
        .catch((error: unknown) => {
          if (error instanceof HostileArchive)
            throw new ImportFailed('This pack is bigger than Cubepals takes.', error.message)
          throw error
        })
      const built = await this.#builder.build(
        { path: upload, fileName: pending.fileName, sha512: arrived.sha512 },
        work,
      )
      const at = new Date()
      if (built.kind === 'refused') {
        await packImportRefused(this.#db, importId, { refusal: built.message, detail: built.detail, at })
        return
      }
      if (built.kind === 'catalog') {
        const result = await this.#catalogResult(built.projectId, built.versionId)
        await packImportReady(this.#db, importId, { packSha512: null, result, at })
        return
      }
      const key = await store.ingestFile(built.path, built.sha512)
      await this.#db.transaction(async (tx) => {
        await recordStored(tx, { sha512: built.sha512, key, sizeBytes: built.sizeBytes, source: 'built' })
        await savePackContents(tx, { sha512: built.sha512, ...built.contents })
        await packImportReady(tx, importId, { packSha512: built.sha512, result: built.summary, at })
      })
    } catch (error) {
      if (error instanceof ImportFailed) {
        await packImportRefused(this.#db, importId, {
          refusal: error.message,
          detail: error.detail,
          at: new Date(),
        })
        return
      }
      throw error
    } finally {
      await rm(work, { recursive: true, force: true })
      if (pending !== null)
        await store
          .delete(pending.key)
          .then(() => deletePendingUpload(this.#db, pending.id))
          .catch(() => undefined)
    }
  }

  /** An import whose job gave up: it can't be read after all, and its owner is told so. */
  async importGaveUp(importId: string, error: string): Promise<void> {
    await packImportRefused(this.#db, importId, {
      refusal: 'Cubepals couldn’t finish reading this pack. Try uploading it again.',
      detail: error,
      at: new Date(),
    })
  }

  /** What a pack from the catalog is, when an uploaded file turned out to be one. */
  async #catalogResult(projectId: string, versionId: string): Promise<PackImportJson> {
    const [project, version] = await Promise.all([
      this.#catalog.project(projectId),
      this.#catalog.version(versionId),
    ])
    return {
      format: 'mrpack',
      name: project?.name ?? 'A modpack',
      versionLabel: version?.versionLabel ?? '',
      gameVersion: version?.gameVersions[0] ?? '',
      loader: (version && loaderOfPack(version.loaders)) ?? 'fabric',
      loaderVersion: null,
      tier: '4g',
      playersNeedIt: true,
      mods: 0,
      catalog: { projectId, versionId },
      notes: [],
    }
  }

  /**
   * The pack a ready import builds a server from: pinned as the owner's own pack, or as the
   * catalog pack the file turned out to be (`catalog`). Null for one not ready.
   */
  async pinnedFrom(
    actor: Actor & { kind: 'user' },
    importId: string,
  ): Promise<
    | { kind: 'built'; pinned: PinnedModpack; summary: PackImportJson }
    | { kind: 'catalog'; projectId: string; versionId: string }
  > {
    const record = await this.#owned(actor, importId)
    if (record.status === 'reading')
      throw new AppError('invalid_choice', 'Cubepals is still reading this pack. Give it a moment.')
    if (record.status === 'refused' || record.result === null)
      throw new AppError('invalid_choice', record.refusal ?? 'Cubepals couldn’t read this pack.')
    const result = record.result
    if (result.catalog) return { kind: 'catalog', ...result.catalog }
    if (record.packSha512 === null) throw new AppError('invalid_choice', 'Cubepals couldn’t read this pack.')
    const [stored] = await this.#db
      .select({ key: schema.storedArtifacts.key, sizeBytes: schema.storedArtifacts.sizeBytes })
      .from(schema.storedArtifacts)
      .where(eq(schema.storedArtifacts.sha512, record.packSha512))
    if (stored === undefined)
      throw new AppError('invalid_choice', 'This pack isn’t kept any more. Upload it again.')
    return {
      kind: 'built',
      summary: result,
      pinned: {
        catalog: 'upload',
        projectId: record.id,
        versionId: record.packSha512.slice(0, 32),
        name: result.name,
        versionLabel: result.versionLabel,
        artifact: {
          ref: { kind: 'stored', key: stored.key },
          sha512: record.packSha512,
          sizeBytes: stored.sizeBytes,
          fileName: `${slugOf(result.name)}.mrpack`,
        },
        page: null,
        environment: result.playersNeedIt ? 'both' : 'server',
        icon: null,
        ...(result.javaProperties && Object.keys(result.javaProperties).length > 0
          ? { javaProperties: result.javaProperties }
          : {}),
      },
    }
  }

  async #owned(actor: Actor & { kind: 'user' }, importId: string): Promise<PackImportRecord> {
    const record = await loadPackImport(this.#db, importId)
    if (record === null || record.ownerId !== actor.userId) throw new NotFound('Upload')
    return record
  }

  // ─── Links and versions ────────────────────────────────────────────────────────────────────

  /**
   * A link pasted where packs are searched. A Modrinth pack's page or file becomes that pack, at
   * the version the link names; CurseForge's are recognised and answered with where to download
   * the server pack instead, since Blockly can't download from CurseForge.
   */
  async linkOf(
    pasted: string,
  ): Promise<
    | { kind: 'pack'; projectId: string; versionRef: string | null }
    | Extract<PackLinkView, { kind: 'refused' }>
  > {
    // A link copied from an address bar often comes without its https://.
    const trimmed = pasted.trim()
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const catalog = this.#catalog.linkOf(url)
    if (catalog !== null) {
      if (catalog.kind === 'mod' || catalog.kind === 'plugin')
        return {
          kind: 'refused',
          message:
            'That’s a single mod, not a modpack. Make the server first, then add it from its Mods page.',
          page: null,
        }
      return { kind: 'pack', projectId: catalog.project, versionRef: catalog.version }
    }
    const curseforge = this.#curseforge.linkOf(url)
    if (curseforge !== null)
      return {
        kind: 'refused',
        message:
          curseforge.kind === 'modpack'
            ? `Cubepals can’t download from CurseForge. On ${curseforge.name}’s page, download its server pack from Files, then drop it here.`
            : 'Cubepals can’t download from CurseForge. Download the pack’s server files there, then drop them here.',
        page: curseforge.filesPage,
      }
    return {
      kind: 'refused',
      message:
        'Cubepals reads links to Modrinth packs. For a pack from anywhere else, download it and drop the file here.',
      page: null,
    }
  }

  /** The versions of a pack a server can run, newest first, as a picker lists them. */
  async versions(projectId: string): Promise<PackVersionView[]> {
    const versions = await this.#catalog.modpackVersions(projectId)
    return versions.flatMap((version) => {
      if (serverEnvironment(version.environment) === null) return []
      const loader = loaderOfPack(version.loaders)
      if (loader === null) return []
      const gameVersion = version.gameVersions
        .filter((id) => packRuns(id, loader))
        .sort((a, b) => compareVersions(b, a))[0]
      if (gameVersion === undefined) return []
      return [
        {
          versionId: version.versionId,
          label: version.versionLabel,
          gameVersion,
          loaderLabel: LOADER_LABELS[loader],
          publishedAt: version.publishedAt.toISOString(),
        },
      ]
    })
  }

  /**
   * A newer version of the pack a server plays, from its catalog: the newest one a server can
   * run that is newer than the one pinned. Never applied by itself: a pinned server stays on its
   * version until its owner moves it.
   */
  async updateFor(revision: Pick<ServerRevision, 'modpack' | 'gameVersion'>): Promise<PackUpdateView | null> {
    const pack = revision.modpack
    if (pack === null || pack.catalog !== this.#catalog.id) return null
    const versions = await this.versions(pack.projectId).catch(() => [])
    const pinned = versions.find((v) => v.versionId === pack.versionId)
    const newest = versions[0]
    if (newest === undefined || newest.versionId === pack.versionId) return null
    if (pinned !== undefined && Date.parse(newest.publishedAt) <= Date.parse(pinned.publishedAt)) return null
    // A world never moves back: an update onto an older Minecraft isn't one.
    if (compareVersions(newest.gameVersion, revision.gameVersion) < 0) return null
    return {
      versionId: newest.versionId,
      label: newest.label,
      gameVersion: newest.gameVersion,
      movesWorld: compareVersions(newest.gameVersion, revision.gameVersion) > 0,
      release: null,
    }
  }

  /** Whether an owner's server is theirs to change: for the pack pages. */
  async server(actor: Actor, serverId: string) {
    return authorize(actor, await findServer(this.#db, serverId))
  }
}

class ImportFailed extends Error {
  readonly detail: string
  constructor(sentence: string, detail: string) {
    super(sentence)
    this.detail = detail
  }
}

/** An uploaded pack's name as it may be kept: its last path segment, a zip or a Modrinth pack. */
function packFileName(name: string): string | null {
  const base = (name.split(/[\\/]/).pop() ?? '').trim()
  const safe = base.replace(/[^A-Za-z0-9._+ ()[\]-]+/g, '-').replace(/^[-. ]+/, '')
  if (!/\.(zip|mrpack)$/i.test(safe) || safe.length < 5 || safe.length > 160) return null
  return safe
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'modpack'

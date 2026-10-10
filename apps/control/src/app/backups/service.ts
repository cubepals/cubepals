// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { type Db, schema, type Tx } from '@blockly/db'
import {
  comesWith,
  entitlementsFor,
  planThatRuns,
  WORLD_SHARE_OF_DISK,
} from '../../domain/account/entitlements.ts'
import type { RevisionDraft } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import {
  isAddedJar,
  levelNameOf,
  PROPERTIES_FILE,
  type UploadedWorld,
  uploadedWorld,
  wantedInWorldArchive,
} from '../../minecraft/uploads.ts'
import { compareVersions } from '../../minecraft/versions.ts'
import { DOWNLOAD_NOTE, jarsInNote } from '../../minecraft/world-download.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import type { ArtifactService } from '../artifacts/service.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import { type FileFormats, UnreadableFile } from '../ports/formats.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import { RuntimeUnsupported } from '../ports/runtime.ts'
import { requireWithinPlan, runsOf } from '../revisions/caps.ts'
import { pinUnpinned } from '../revisions/pins.ts'
import { acknowledged, type ChangeOptions, draftOf } from '../revisions/service.ts'
import type { Runtimes } from '../runtimes/router.ts'
import {
  findServer,
  grownStorage,
  insertRevision,
  loadRevision,
  loadRuntime,
  lockServer,
  setDesired,
} from '../servers/persistence.ts'
import type { ServerTransitions } from '../servers/transitions.ts'
import { deletePendingUpload, insertPendingUpload, loadPendingUpload } from '../uploads/persistence.ts'
import { insertWorld, listWorlds, markPruned, markWorldDeleted } from '../worlds/persistence.ts'
import { downloadsErased, downloadsToErase } from './download-records.ts'
import { WorldDownloads } from './downloads.ts'
import {
  archivesErased,
  archivesToErase,
  type BackupRecord,
  type BackupTrigger,
  downloadsSince,
  insertArchive,
  latestBackup,
  loadBackup,
  readySnapshots,
  setBackupStatus,
} from './persistence.ts'

/** Snapshots taken before a change, a restore or a move: the latest few, apart from the owner's own. */
const SAFETY_KEPT = 3
const SAFETY: readonly BackupTrigger[] = ['pre_apply', 'pre_restore', 'pre_relocate']

const DAY_MS = 24 * 60 * 60 * 1000

/** Archives outlive their server; one a week keeps a month of retention at four or five copies. */
const SCHEDULED_ARCHIVE_EVERY_MS = 7 * 24 * 60 * 60 * 1000

/** A world download can be as large as one upload to the store takes. */
const MAX_WORLD_BYTES = 4 * 1024 ** 3
/** The largest world download a disk of `diskGb` has room for. */
const worldUploadLimit = (diskGb: number): number =>
  Math.min(MAX_WORLD_BYTES, Math.floor(diskGb * WORLD_SHARE_OF_DISK * 1024 ** 3))
/** Uploading a large world takes a while; the link only has to be valid when it starts. */
const WORLD_UPLOAD_LINK_SECONDS = 60 * 60
/** Long enough to read an uploaded world's properties and level.dat. */
const READ_LINK_SECONDS = 30 * 60
/** A level.dat is a few kilobytes; server.properties less. */
const MAX_WORLD_FILE_BYTES = 4 * 1024 * 1024
/** An uploaded world stays at least this long, whatever the plan keeps, so there is time to restore it. */
const UPLOADED_KEPT_DAYS = 7

/** Where an archive lives in the store: under its server, named by its backup. */

/**
 * Backups (§15.5): snapshots now, restores from them, and how many are kept. A restore never
 * brings back who could join: the access record is re-imposed after it (§15.1).
 */
export class BackupService {
  readonly #db: Db
  readonly #transitions: ServerTransitions
  readonly #events: EventBus
  readonly #runtime: Runtimes
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #formats: FileFormats
  readonly #artifacts: ArtifactService
  readonly #builds: LoaderBuilds
  /** What an archive's owner downloads of it (`downloads.ts`). */
  readonly downloads: WorldDownloads

  constructor(deps: {
    db: Db
    transitions: ServerTransitions
    events: EventBus
    runtime: Runtimes
    policy: AccessPolicy
    artifacts: ArtifactService
    ports: {
      capabilities: DeploymentCapabilities
      formats: FileFormats
      loaderBuilds: LoaderBuilds
      jobs: JobQueue
    }
  }) {
    this.#db = deps.db
    this.#transitions = deps.transitions
    this.#events = deps.events
    this.#runtime = deps.runtime
    this.#policy = deps.policy
    this.#caps = deps.ports.capabilities
    this.#formats = deps.ports.formats
    this.#artifacts = deps.artifacts
    this.#builds = deps.ports.loaderBuilds
    this.downloads = new WorldDownloads({ db: deps.db, policy: deps.policy, ...deps.ports })
  }

  /** A snapshot now. While the server runs, saving pauses so the world on disk is consistent. */
  async createBackup(actor: Actor, serverId: string, requestId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      await this.#policy.require(tx, server.ownerId, { kind: 'snapshot_backup' })
      if (server.lifecycle.status !== 'running' && server.lifecycle.status !== 'stopped')
        throw new AppError(
          'invalid_transition',
          `A server that is ${server.lifecycle.status} can't be backed up right now.`,
        )
      const { handle } = await loadRuntime(tx, server.id, this.#runtime.providers)
      if (handle === null)
        throw new AppError('invalid_transition', 'This server has no world to back up yet.')
      await this.#transitions.enqueue(tx, server, 'backup', {
        requestedBy: requestedBy(actor),
        idempotencyKey: `backup:${requestId}`,
        input: { trigger: 'manual' },
      })
      await this.#audit(tx, actor, 'server.backup_requested', server.id, {})
    })
  }

  /**
   * A snapshot's world packed into the archive store (§15.5): it can be downloaded, and it
   * outlives the server for as long as the owner's plan keeps archives.
   */
  async archiveBackup(actor: Actor, serverId: string, backupId: string, requestId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      await this.#policy.require(tx, server.ownerId, { kind: 'create_archive' })
      const standing = await loadStanding(tx, server.ownerId)
      const perDay = entitlementsFor(standing.plan, standing.limitOverrides).backupPolicy.downloadsPerDay
      if (perDay !== null && (await downloadsSince(tx, server.id, new Date(Date.now() - DAY_MS))) >= perDay)
        throw new AppError(
          'rate_limited',
          'You can make one download a day. The one you made today is below, ready or on its way.',
        )
      const snapshot = await loadBackup(tx, backupId)
      if (
        snapshot === null ||
        snapshot.serverId !== server.id ||
        snapshot.tier !== 'snapshot' ||
        snapshot.status !== 'ready'
      )
        throw new NotFound('Backup')
      await this.#queueArchive(tx, server, snapshot, {
        trigger: 'manual',
        requestedBy: requestedBy(actor),
        idempotencyKey: `archive:${requestId}`,
      })
      await this.#audit(tx, actor, 'server.archive_requested', server.id, { backupId })
    })
  }

  /**
   * The first half of bringing a world back: a link the browser puts a download at, signed for
   * the size it said. Restoring from an archive is the owner's right on any plan (§15.4).
   */
  async beginWorldUpload(
    actor: Actor,
    serverId: string,
    file: { fileName: string; sizeBytes: number },
  ): Promise<{ ticket: string; url: string; headers: Record<string, string> }> {
    const fileName = (file.fileName.split(/[\\/]/).pop() ?? '').trim()
    if (!/\.(tar\.gz|tgz)$/i.test(fileName))
      throw new AppError('invalid_upload', 'Upload a world you downloaded from Cubepals: a .tar.gz file.')
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > MAX_WORLD_BYTES)
      throw new AppError('invalid_upload', 'A world download can be up to 4 GB.')
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await findServer(tx, serverId))
      // The biggest disk it may have: a world bigger than its disk now gets a bigger one when it is
      // brought back, where its plan's disks grow.
      const standing = await loadStanding(tx, server.ownerId)
      const plan = entitlementsFor(standing.plan, standing.limitOverrides)
      const limit = worldUploadLimit(Math.max(plan.storage.mostGb, await grownStorage(tx, server.id)))
      if (file.sizeBytes > limit)
        throw new AppError(
          'invalid_upload',
          `This server has room for a world download of up to ${Number((limit / 1024 ** 3).toFixed(1))} GB.`,
        )
      await this.#policy.require(tx, server.ownerId, { kind: 'restore_archive' })
      const store = requireCapability(this.#caps, 'archives')
      const id = randomUUID()
      const key = store.newKey('world_upload', { serverId: server.id, id })
      await insertPendingUpload(tx, {
        id,
        ownerId: server.ownerId,
        serverId: server.id,
        kind: 'world',
        key,
        fileName: fileName.slice(0, 200),
        sizeBytes: file.sizeBytes,
        sha512: null,
      })
      const target = await store.presignPut(key, WORLD_UPLOAD_LINK_SECONDS, 'browser', file.sizeBytes)
      return { ticket: id, url: target.url, headers: target.headers }
    })
  }

  /**
   * The second half: the download is read for the world it holds, then kept as a backup of the
   * server, to be restored like any other. A world the server has never had is recorded as one
   * that exists only in a backup, until it is restored.
   */
  async finishWorldUpload(
    actor: Actor,
    serverId: string,
    ticket: string,
    name?: string,
  ): Promise<BackupRecord> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const pending = await loadPendingUpload(this.#db, ticket)
    if (pending === null || pending.kind !== 'world' || pending.serverId !== server.id)
      throw new NotFound('Upload')
    await this.#db.transaction((tx) => this.#policy.require(tx, server.ownerId, { kind: 'restore_archive' }))
    const store = requireCapability(this.#caps, 'archives')
    const arrived = await store.head(pending.key)
    if (arrived === null) throw new AppError('invalid_upload', 'The file never arrived. Upload it again.')
    if (arrived.sizeBytes !== pending.sizeBytes)
      throw new AppError('invalid_upload', 'The file didn’t arrive whole. Upload it again.')
    const link = await store.presignGet(pending.key, READ_LINK_SECONDS, 'browser')
    const standing = await loadStanding(this.#db, server.ownerId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    // A world made with mods is looked through whole on a plan without them: opened on plain
    // Minecraft, it would lose every modded block and item without a word.
    const { world, addedJars } = await this.#readWorld(link.url, !plan.mayUseMods)
    if (addedJars && !plan.mayUseMods)
      throw new AppError(
        'not_entitled',
        comesWith('Worlds made with mods', planThatRuns({ tier: '3g', loader: 'fabric', modded: true })),
      )
    const desired = await loadRevision(this.#db, server.desiredRevisionId)
    if (compareVersions(world.gameVersion, desired.gameVersion) > 0)
      throw new AppError(
        'version_downgrade',
        `This world was last played on Minecraft ${world.gameVersion}, newer than this server's ${desired.gameVersion}. Move the server to ${world.gameVersion} first, then try again.`,
      )
    const days = Math.max(plan.backupPolicy.archiveRetentionDays, UPLOADED_KEPT_DAYS)
    const now = new Date()

    return this.#db.transaction(async (tx) => {
      const locked = authorize(actor, await lockServer(tx, server.id))
      const known = (await listWorlds(tx, locked.id)).find((w) => w.levelName === world.levelName)
      let worldId = known?.id
      if (worldId === undefined) {
        worldId = (
          await insertWorld(tx, {
            serverId: locked.id,
            levelName: world.levelName,
            name: name?.trim().slice(0, 40) || 'Uploaded world',
            seed: world.seed,
            levelType: world.levelType,
            hardcore: world.hardcore,
            generatedOnVersion: world.gameVersion,
          })
        ).id
        // Not on the server until the backup is restored.
        await markWorldDeleted(tx, worldId, now)
        await markPruned(tx, [worldId], now)
      }
      const backup = await insertArchive(tx, {
        id: randomUUID(),
        serverId: locked.id,
        worldId,
        revisionId: locked.desiredRevisionId,
        trigger: 'uploaded',
        status: 'ready',
        archiveKey: pending.key,
        sizeBytes: arrived.sizeBytes,
        expiresAt: new Date(now.getTime() + days * 86_400_000),
        worldFacts: {
          seed: world.seed,
          levelType: world.levelType,
          hardcore: world.hardcore,
          gameVersion: world.gameVersion,
        },
      })
      // The key is the backup's now; nothing is left to clear.
      await deletePendingUpload(tx, pending.id)
      await this.#audit(tx, actor, 'server.world_uploaded', locked.id, {
        backupId: backup.id,
        level: world.levelName,
      })
      await this.#events.publish(tx, { type: 'backup_changed', serverId: locked.id, ownerId: locked.ownerId })
      return backup
    })
  }

  /**
   * Reads an archive back from the store, the way an upload is read, as far as the server's
   * settings and the level.dat of the world they name. Throws when it doesn't hold them: a copy
   * that fails this is not one anything is let go on the strength of. The
   * level.dat is the server's own bytes, copied, so its presence is what is checked, not its
   * contents: a server that ran on it opened it.
   */
  async verifyArchive(key: string): Promise<void> {
    const store = requireCapability(this.#caps, 'archives')
    const link = await store.presignGet(key, READ_LINK_SECONDS, 'browser')
    const text = new TextDecoder()
    const levelOf = (found: ReadonlyMap<string, Uint8Array>): string | null => {
      const raw = found.get(PROPERTIES_FILE)
      if (raw === undefined) return null
      return levelNameOf(this.#formats.decode('properties', text.decode(raw)) as Record<string, string>)
    }
    const files = await this.#formats.readTarball(link.url, {
      wanted: wantedInWorldArchive,
      enough: (found) => {
        try {
          const level = levelOf(found)
          return level !== null && found.has(`${level}/level.dat`)
        } catch {
          return false
        }
      },
      maxEntryBytes: MAX_WORLD_FILE_BYTES,
    })
    const level = levelOf(files)
    if (level === null) throw new Error('The copy has no server settings naming a world')
    if ((files.get(`${level}/level.dat`)?.length ?? 0) === 0)
      throw new Error(`The copy has no ${level}/level.dat`)
  }

  /** The world a download holds: named in its server.properties, described in its level.dat. */
  async #readWorld(url: string, lookForJars: boolean): Promise<{ world: UploadedWorld; addedJars: boolean }> {
    const text = new TextDecoder()
    let addedJars = false
    const properties = (found: ReadonlyMap<string, Uint8Array>): Record<string, string> | null => {
      const raw = found.get(PROPERTIES_FILE)
      return raw === undefined
        ? null
        : (this.#formats.decode('properties', text.decode(raw)) as Record<string, string>)
    }
    let files: Map<string, Uint8Array>
    try {
      files = await this.#formats.readTarball(url, {
        wanted: (path) => {
          if (isAddedJar(path)) addedJars = true
          // A world downloaded from Cubepals names the mods it was played with in its note instead.
          return wantedInWorldArchive(path) || path === DOWNLOAD_NOTE
        },
        enough: (found) => {
          // Looking for jars reads the whole download: where they sit in it is anyone's guess.
          if (lookForJars) return false
          try {
            const read = properties(found)
            const level = read === null ? null : levelNameOf(read)
            return level !== null && found.has(`${level}/level.dat`)
          } catch {
            return false
          }
        },
        maxEntryBytes: MAX_WORLD_FILE_BYTES,
      })
    } catch (error) {
      if (error instanceof UnreadableFile)
        throw new AppError('invalid_upload', 'This file isn’t a whole world download (.tar.gz).')
      throw error
    }
    const note = files.get(DOWNLOAD_NOTE)
    if (note !== undefined && jarsInNote(text.decode(note)).length > 0) addedJars = true
    let read: Record<string, string> | null
    try {
      read = properties(files)
    } catch {
      throw new AppError('invalid_upload', 'The download’s server settings can’t be read.')
    }
    const level = read === null ? null : levelNameOf(read)
    const levelDat = level === null ? undefined : files.get(`${level}/level.dat`)
    const decoded =
      levelDat === undefined
        ? undefined
        : await this.#formats.decodeNbt(levelDat).catch(() => {
            throw new AppError('invalid_upload', `The world’s ${level}/level.dat can’t be read.`)
          })
    const world = uploadedWorld(read, decoded)
    if ('refused' in world) throw new AppError('invalid_upload', world.refused)
    return { world, addedJars }
  }

  async deleteBackup(actor: Actor, serverId: string, backupId: string): Promise<void> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const backup = await loadBackup(this.#db, backupId)
    if (backup === null || backup.serverId !== server.id) throw new NotFound('Backup')
    // While a world rests, the copy it rests in is the world itself: nothing deletes it but
    // deleting the server.
    if (backup.trigger === 'stored' && backup.status === 'ready' && backup.expiresAt === null)
      throw new AppError('invalid_choice', 'This is the world itself while it rests. Wake the server first.')
    // A pending archive finishes or fails on its own; a failed one is only cleared from view.
    if (backup.status === 'failed') await setBackupStatus(this.#db, [backup.id], 'deleted')
    if (backup.status !== 'ready') return
    await this.#forget(server, [backup])
    await this.#db.transaction((tx) =>
      this.#audit(tx, actor, 'server.backup_deleted', server.id, { backupId }),
    )
  }

  /**
   * The world from a backup, as the server's world. With its configuration, the settings and mods
   * from then come back too, as a `restore` revision; without, a world from a newer game version
   * can't be opened, so that is refused.
   */
  restoreBackup(
    actor: Actor,
    serverId: string,
    backupId: string,
    requestId: string,
    options: ChangeOptions & { withConfiguration: boolean },
  ): Promise<MinecraftServer> {
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      const backup = await loadBackup(tx, backupId)
      if (backup === null || backup.serverId !== server.id || backup.status !== 'ready')
        throw new NotFound('Backup')
      await this.#policy.require(tx, server.ownerId, {
        kind: backup.tier === 'archive' ? 'restore_archive' : 'restore_backup',
      })
      const desired = await loadRevision(tx, server.desiredRevisionId)
      // A failed server comes back up from the restore: that is a start, checked as one.
      const fromFailure = server.lifecycle.status === 'failed'
      if (fromFailure)
        await this.#policy.require(tx, server.ownerId, {
          kind: 'start_server',
          runs: runsOf(server.memoryTier, desired),
        })
      // An upload brings a world, never a configuration: its own version must open here.
      if (backup.worldFacts !== null) {
        options = { ...options, withConfiguration: false }
        if (compareVersions(backup.worldFacts.gameVersion, desired.gameVersion) > 0)
          throw new AppError(
            'version_downgrade',
            `This world was last played on Minecraft ${backup.worldFacts.gameVersion}, newer than this server's ${desired.gameVersion}. Move the server to ${backup.worldFacts.gameVersion} first.`,
          )
      }
      const then = await loadRevision(tx, backup.revisionId)
      if (!options.withConfiguration && compareVersions(then.gameVersion, desired.gameVersion) > 0)
        throw new AppError(
          'version_downgrade',
          `This backup's world ran on Minecraft ${then.gameVersion}, newer than the server has now. Restore it with its settings from then.`,
        )
      let revisionId: string | undefined
      if (options.withConfiguration) {
        const draft: RevisionDraft = {
          ...draftOf(then),
          // A backup's settings never change how players are checked: that has its own setting.
          settings: { ...then.settings, onlineMode: desired.settings.onlineMode },
          reason: 'restore',
          basedOnRevisionId: then.id,
        }
        // A backup's settings are a configuration like any other: within the plan it runs on now.
        const standing = await loadStanding(tx, server.ownerId)
        requireWithinPlan(entitlementsFor(standing.plan, standing.limitOverrides), draft)
        await pinUnpinned(this.#builds, draft)
        draft.acknowledgedRevoked = await acknowledged(tx, draft, options)
        const revision = await insertRevision(tx, server.id, draft, requestedBy(actor))
        await this.#artifacts.pinned(tx, revision.mods, revision.modpack)
        revisionId = revision.id
      }
      const moved = await setDesired(tx, server, {
        ...(revisionId ? { revisionId } : {}),
        activeWorldId: backup.worldId,
      })
      const { server: restoring } = await this.#transitions.command(
        tx,
        moved,
        { type: 'restore' },
        {
          requestedBy: requestedBy(actor),
          idempotencyKey: `restore:${requestId}`,
          // A stopped server stays stopped; one running or failed comes back up.
          input: { backupId, running: server.lifecycle.status !== 'stopped', fromFailure },
        },
      )
      await this.#audit(tx, actor, 'server.restore_requested', server.id, {
        backupId,
        withConfiguration: options.withConfiguration,
      })
      return restoring
    })
  }

  /** Keeps the newest snapshots the owner's plan allows, and the latest few safety snapshots. */
  async enforceRetention(server: MinecraftServer): Promise<void> {
    const standing = await loadStanding(this.#db, server.ownerId)
    const kept = entitlementsFor(standing.plan, standing.limitOverrides).backupPolicy.snapshotsKept
    const ready = await readySnapshots(this.#db, server.id)
    const own = ready.filter((b) => !SAFETY.includes(b.trigger)).slice(kept)
    const safety = ready.filter((b) => SAFETY.includes(b.trigger)).slice(SAFETY_KEPT)
    await this.#forget(server, [...own, ...safety])
  }

  /**
   * `backup-schedule`, for archives: a weekly archive of the newest daily snapshot, for owners
   * whose plan keeps archives on a deployment that has them. Nothing new was played since the
   * last one when there is no newer snapshot, since daily snapshots follow play.
   */
  async scheduleArchives(servers: readonly MinecraftServer[], now = new Date()): Promise<number> {
    if (this.#caps.archives === null) return 0
    let queued = 0
    for (const server of servers) {
      // An archive is made by the provider that took its snapshot, which must be this one.
      if ((await loadRuntime(this.#db, server.id, this.#runtime.providers)).foreign) continue
      const snapshot = await latestBackup(this.#db, server.id, 'scheduled', 'snapshot')
      if (snapshot === null || snapshot.status !== 'ready') continue
      const last = await latestBackup(this.#db, server.id, 'scheduled', 'archive')
      if (last !== null && last.status !== 'failed') {
        if (now.getTime() - last.createdAt.getTime() < SCHEDULED_ARCHIVE_EVERY_MS) continue
        if (snapshot.createdAt <= last.createdAt) continue
      }
      await this.#db.transaction(async (tx) => {
        // The weekly history is a plan's; a download of the world now is everyone's.
        const standing = await loadStanding(tx, server.ownerId)
        if (!entitlementsFor(standing.plan, standing.limitOverrides).backupPolicy.archiveEnabled) return
        const decision = await this.#policy.check(tx, server.ownerId, { kind: 'create_archive' })
        if (!decision.ok) return
        await this.#queueArchive(tx, server, snapshot, {
          trigger: 'scheduled',
          requestedBy: 'system:backup-schedule',
          idempotencyKey: `archive:scheduled:${snapshot.id}`,
        })
        queued++
      })
    }
    return queued
  }

  /**
   * Deletes from the store what no one can see any more: deleted, expired and failed archives,
   * and the world downloads made of them or past their day (`downloads.ts`). Without the
   * archives capability they wait, and go once it is back (§15.4).
   */
  async eraseArchives(): Promise<number> {
    const store = this.#caps.archives
    if (store === null) return 0
    const copies = await downloadsToErase(this.#db, new Date())
    for (const copy of copies) await store.delete(copy.key)
    await downloadsErased(
      this.#db,
      copies.map((copy) => copy.id),
    )
    const erased: string[] = []
    for (const archive of await archivesToErase(this.#db)) {
      await store.delete(archive.archiveKey as string)
      erased.push(archive.id)
    }
    await archivesErased(this.#db, erased)
    return erased.length
  }

  /**
   * An archive of a snapshot, recorded now with the key it will have and made by the `archive`
   * operation. A repeated request finds its operation already there and records nothing.
   */
  async #queueArchive(
    tx: Tx,
    server: MinecraftServer,
    snapshot: BackupRecord,
    request: { trigger: BackupTrigger; requestedBy: string; idempotencyKey: string },
  ): Promise<void> {
    requireCapability(this.#caps, 'archives')
    const archiveId = crypto.randomUUID()
    const op = await this.#transitions.enqueue(tx, server, 'archive', {
      requestedBy: request.requestedBy,
      idempotencyKey: request.idempotencyKey,
      input: { archiveId, snapshotId: snapshot.id },
    })
    if (op.input.archiveId !== archiveId) return
    await insertArchive(tx, {
      id: archiveId,
      serverId: server.id,
      worldId: snapshot.worldId,
      revisionId: snapshot.revisionId,
      trigger: request.trigger,
      archiveKey: requireCapability(this.#caps, 'archives').newKey('archive', {
        serverId: server.id,
        id: archiveId,
      }),
    })
    await this.#events.publish(tx, { type: 'backup_changed', serverId: server.id, ownerId: server.ownerId })
  }

  /**
   * Frees snapshots where the provider can; where its snapshots only expire, they stop being
   * offered and live out their lifetime at the provider. Archives leave the store now, or once the
   * deployment has archives again.
   */
  async #forget(server: MinecraftServer, backups: readonly BackupRecord[]): Promise<void> {
    if (backups.length === 0) return
    // Another provider's snapshots aren't this deployment's to delete: like snapshots that only
    // expire, they stop being offered and live out their lifetime there.
    const foreign = (await loadRuntime(this.#db, server.id, this.#runtime.providers)).foreign
    for (const backup of backups)
      if (backup.snapshotHandle !== null && !foreign)
        await this.#runtime.deleteSnapshot(backup.snapshotHandle).catch((error) => {
          if (!(error instanceof RuntimeUnsupported)) throw error
        })
    await this.#db.transaction(async (tx) => {
      await setBackupStatus(
        tx,
        backups.map((b) => b.id),
        'deleted',
      )
      await this.#events.publish(tx, { type: 'backup_changed', serverId: server.id, ownerId: server.ownerId })
    })
    if (backups.some((b) => b.tier === 'archive')) await this.eraseArchives()
  }

  async #audit(tx: Tx, actor: Actor, action: string, serverId: string, data: Record<string, unknown>) {
    await tx.insert(schema.auditLog).values({
      actor: requestedBy(actor),
      action,
      subjectType: 'server',
      subjectId: serverId,
      data,
    })
  }
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import { DAY_MS, HOUR_S, MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import { type Db, schema, type Tx } from '@blockly/db'
import { entitlementsFor, PLAN_KEYS } from '../../domain/account/entitlements.ts'
import type { RevisionDraft } from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { levelNameOf, PROPERTIES_FILE, wantedInWorldArchive } from '../../minecraft/uploads.ts'
import { compareVersions } from '../../minecraft/versions.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import type { ArtifactService } from '../artifacts/service.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import type { FileFormats, PackArchives, WorldArchives } from '../ports/formats.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'
import { RuntimeUnsupported } from '../ports/runtime.ts'
import { requireWithinPlan, runsOf } from '../revisions/caps.ts'
import { pinUnpinned } from '../revisions/pins.ts'
import { acknowledged, type ChangeOptions, draftOf } from '../revisions/service.ts'
import type { Runtimes } from '../runtimes/router.ts'
import type { OfficialFiles } from '../servers/own-files.ts'
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
import { insertPendingUpload } from '../uploads/persistence.ts'
import { keptWorlds } from '../worlds/persistence.ts'
import { downloadsErased, downloadsToErase } from './download-records.ts'
import { WorldDownloads } from './downloads.ts'
import { NewWorldImports } from './new-world-imports.ts'
import {
  archivesErased,
  archivesToErase,
  type BackupRecord,
  type BackupTrigger,
  backupsInUse,
  downloadsSince,
  insertArchive,
  latestBackup,
  latestRestorePoint,
  loadBackup,
  readySnapshots,
  setBackupStatus,
} from './persistence.ts'
import { WorldImports } from './world-imports.ts'
import { MAX_WORLD_BYTES, refusedByName, worldUploadLimit } from './world-reading.ts'

/** Snapshots taken before a change, a restore or a move: the latest few, apart from the owner's own. */
const SAFETY_KEPT = 3
const SAFETY: readonly BackupTrigger[] = ['pre_apply', 'pre_restore', 'pre_relocate']

/** Archives outlive their server; one a week keeps a month of retention at four or five copies. */
const SCHEDULED_ARCHIVE_EVERY_MS = 7 * DAY_MS

/** Uploading a large world takes a while; the link only has to be valid when it starts. */
const WORLD_UPLOAD_LINK_SECONDS = HOUR_S
/** Long enough to read an uploaded world's properties and level.dat. */
const READ_LINK_SECONDS = 30 * MINUTE_S
/** A world is never larger than the largest disk any plan offers, so neither is a download of one inflated. */
const MAX_INFLATED_WORLD_BYTES =
  Math.max(...PLAN_KEYS.map((plan) => entitlementsFor(plan).storage.mostGb)) * 1024 ** 3
/** How long a world download is read for: as long as the link it is read through. */
const READ_DEADLINE_MS = READ_LINK_SECONDS * SECOND_MS
/** A level.dat is a few kilobytes; server.properties less. */
const MAX_WORLD_FILE_BYTES = 4 * 1024 * 1024
/**
 * What reading a download keeps: its properties, its note and a level.dat for each world beside
 * them. A server with many worlds has a few dozen; the bytes held stay a few times one file's limit.
 */
const MAX_KEPT_WORLD_FILES = 64
const MAX_KEPT_WORLD_BYTES = 4 * MAX_WORLD_FILE_BYTES
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
  /** Worlds their owners upload, brought in as backups (`world-imports.ts`). */
  readonly imports: WorldImports
  /** Worlds their owners upload while making a server, to make it from (`new-world-imports.ts`). */
  readonly newWorlds: NewWorldImports

  constructor(deps: {
    db: Db
    transitions: ServerTransitions
    events: EventBus
    runtime: Runtimes
    policy: AccessPolicy
    artifacts: ArtifactService
    official?: OfficialFiles
    ports: {
      capabilities: DeploymentCapabilities
      formats: FileFormats
      archives: PackArchives & WorldArchives
      loaderBuilds: LoaderBuilds
      jobs: JobQueue
      profiles: PlayerProfiles
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
    const { official, ports } = deps
    this.downloads = new WorldDownloads({ db: deps.db, policy: deps.policy, official, ...ports })
    this.newWorlds = new NewWorldImports({ db: deps.db, policy: deps.policy, ...ports })
    this.imports = new WorldImports({
      db: deps.db,
      policy: deps.policy,
      events: deps.events,
      forNewServers: this.newWorlds,
      ...ports,
    })
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
    const refused = refusedByName(fileName)
    if (refused !== null) throw new AppError('invalid_upload', refused)
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > MAX_WORLD_BYTES)
      throw new AppError('invalid_upload', 'A world can be up to 4 GB.')
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
          `This server has room for a world of up to ${Number((limit / 1024 ** 3).toFixed(1))} GB.`,
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
   * The second half: the world is read off the request, on a worker (`world-imports.ts`), and kept
   * as a backup of the server, to be restored like any other.
   */
  finishWorldUpload(
    actor: Actor,
    serverId: string,
    ticket: string,
    name?: string,
  ): Promise<{ importId: string }> {
    return this.imports.finish(actor, serverId, ticket, name)
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
      maxKeptEntries: MAX_KEPT_WORLD_FILES,
      maxKeptBytes: MAX_KEPT_WORLD_BYTES,
      maxInflatedBytes: MAX_INFLATED_WORLD_BYTES,
      deadlineMs: READ_DEADLINE_MS,
    })
    const level = levelOf(files)
    if (level === null) throw new Error('The copy has no server settings naming a world')
    if ((files.get(`${level}/level.dat`)?.length ?? 0) === 0)
      throw new Error(`The copy has no ${level}/level.dat`)
  }

  /** The names at the top of a copy of a volume in the store: which directories it holds. */
  async topLevelOf(key: string): Promise<Set<string>> {
    const store = requireCapability(this.#caps, 'archives')
    const link = await store.presignGet(key, READ_LINK_SECONDS, 'browser')
    const names = new Set<string>()
    await this.#formats.readTarball(link.url, {
      wanted: (path) => {
        names.add(path.split('/')[0] ?? path)
        return false
      },
      enough: () => false,
      maxEntryBytes: MAX_WORLD_FILE_BYTES,
      maxKeptEntries: MAX_KEPT_WORLD_FILES,
      maxKeptBytes: MAX_KEPT_WORLD_BYTES,
      maxInflatedBytes: MAX_INFLATED_WORLD_BYTES,
      deadlineMs: READ_DEADLINE_MS,
    })
    return names
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
          serverId: server.id,
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

  /**
   * Keeps the newest snapshots the owner's plan allows, and the latest few safety snapshots. One
   * taken each time the server sleeps counts with the daily ones and the owner's own: the plan
   * keeps its last sessions, however often they are. A snapshot a queued or running operation
   * will read stays until it ends, then the next pass trims it; `ending` is the operation asking,
   * done with what it read.
   */
  async enforceRetention(server: MinecraftServer, ending?: string): Promise<void> {
    const standing = await loadStanding(this.#db, server.ownerId)
    const kept = entitlementsFor(standing.plan, standing.limitOverrides).backupPolicy.snapshotsKept
    // A backup a listed world is kept in is the only place that world is: it stays while it is.
    const holding = new Set((await keptWorlds(this.#db, server.id)).values())
    for (const id of await backupsInUse(this.#db, server.id, ending)) holding.add(id)
    const ready = (await readySnapshots(this.#db, server.id)).filter((b) => !holding.has(b.id))
    const own = ready.filter((b) => !SAFETY.includes(b.trigger)).slice(kept)
    const safety = ready.filter((b) => SAFETY.includes(b.trigger)).slice(SAFETY_KEPT)
    await this.#forget(server, [...own, ...safety])
  }

  /**
   * `backup-schedule`, for archives: a weekly archive of the newest restore point, for owners
   * whose plan keeps archives on a deployment that has them. Nothing new was played since the
   * last one when there is no newer restore point, since restore points follow play.
   */
  async scheduleArchives(servers: readonly MinecraftServer[], now = new Date()): Promise<number> {
    if (this.#caps.archives === null) return 0
    let queued = 0
    for (const server of servers) {
      // An archive is made by the provider that took its snapshot, which must be this one.
      if ((await loadRuntime(this.#db, server.id, this.#runtime.providers)).foreign) continue
      const snapshot = await latestRestorePoint(this.#db, server.id)
      if (snapshot === null) continue
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

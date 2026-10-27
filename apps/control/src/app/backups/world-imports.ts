// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bringing a world someone uploaded to their server (docs/world-import.md): the upload read on a
 * worker, its world found whatever shape it came in, a question asked where only its owner knows
 * the answer, and the world kept as a backup of the server, which its owner restores like any
 * other. A world in a Cubepals download is kept as the file it came in; any other is written
 * again as a server keeps it (`minecraft/world-layout.ts`), and what was done is said.
 *
 * Not where an upload is begun (`BackupService.beginWorldUpload`) or a backup restored.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorldImportView } from '@blockly/contracts'
import { NAME_MAX_LENGTH } from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'
import { type Db, schema, type Tx, type WorldImportAnswerJson } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { nextLevelName } from '../../domain/world/world.ts'
import { PROPERTIES_FILE } from '../../minecraft/uploads.ts'
import { compareVersions, isRelease } from '../../minecraft/versions.ts'
import { DOWNLOAD_NOTE, inWorldDownload } from '../../minecraft/world-download.ts'
import { moddedBrands } from '../../minecraft/world-facts.ts'
import { leftOutOf, placeOnServer, playerFilePath } from '../../minecraft/world-layout.ts'
import { isLevelName } from '../../minecraft/worlds.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import type {
  FileFormats,
  PackArchives,
  TarballEntry,
  WorldArchive,
  WorldArchives,
} from '../ports/formats.ts'
import type { JobQueue } from '../ports/jobs.ts'
import { findServer, lockServer } from '../servers/persistence.ts'
import { loadRevisionFields } from '../servers/revision-reads.ts'
import { claimPendingUpload, loadPendingUpload, type PendingUpload } from '../uploads/persistence.ts'
import { insertWorld, listWorlds, markPruned, markWorldDeleted } from '../worlds/persistence.ts'
import { putStream } from './downloads.ts'
import { insertArchive } from './persistence.ts'
import {
  insertWorldImport,
  loadWorldImport,
  type WorldImportRecord,
  worldImportAnswered,
  worldImportAsks,
  worldImportReady,
  worldImportRefused,
} from './world-import-records.ts'
import {
  Asks,
  LINK_SECONDS,
  type Read,
  type ReadingDeps,
  Refused,
  SAID,
  WorldReading,
} from './world-reading.ts'

/** An uploaded world stays at least this long, whatever the plan keeps, so there is time to restore it. */
const UPLOADED_KEPT_DAYS = 7
export class WorldImports {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #formats: FileFormats
  readonly #archives: PackArchives & WorldArchives
  readonly #jobs: JobQueue
  readonly #events: EventBus
  readonly #reading: WorldReading

  constructor(
    deps: ReadingDeps & {
      policy: AccessPolicy
      jobs: JobQueue
      events: EventBus
    },
  ) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#formats = deps.formats
    this.#archives = deps.archives
    this.#jobs = deps.jobs
    this.#events = deps.events
    this.#reading = new WorldReading(deps)
  }

  /** The upload arrived: it is read on a worker, and `view` says how it went. Asked twice, once. */
  async finish(actor: Actor, serverId: string, ticket: string, name?: string): Promise<{ importId: string }> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const pending = await loadPendingUpload(this.#db, ticket)
    const known = await loadWorldImport(this.#db, ticket)
    if (known !== null && known.serverId === server.id) return { importId: known.id }
    if (pending === null || pending.kind !== 'world' || pending.serverId !== server.id)
      throw new NotFound('Upload')
    await this.#db.transaction((tx) => this.#policy.require(tx, server.ownerId, { kind: 'restore_archive' }))
    const arrived = await requireCapability(this.#caps, 'archives').head(pending.key)
    if (arrived === null) {
      // A finish asked at the same time may have recorded it since, and its worker may already
      // have kept the world and removed the upload: that is the same import, not a lost file.
      const since = await loadWorldImport(this.#db, ticket)
      if (since !== null && since.serverId === server.id) return { importId: since.id }
      throw new AppError('invalid_upload', SAID.neverArrived)
    }
    if (arrived.sizeBytes !== pending.sizeBytes)
      throw new AppError('invalid_upload', 'The file didn’t arrive whole. Upload it again.')
    await this.#db.transaction(async (tx) => {
      const made = await insertWorldImport(tx, {
        id: pending.id,
        ownerId: pending.ownerId,
        serverId: server.id,
        fileName: pending.fileName,
        sizeBytes: pending.sizeBytes,
        name: name?.trim().slice(0, NAME_MAX_LENGTH) || null,
      })
      if (!made) return
      await this.#jobs.enqueueWorldImport(tx, pending.id)
      await audit(tx, actor, server.id, 'server.world_upload_finished', { importId: pending.id })
    })
    return { importId: pending.id }
  }

  /** An import as its owner sees it: being read, asking, ready as a backup, or refused and why. */
  async view(actor: Actor, serverId: string, importId: string): Promise<WorldImportView> {
    return viewOf(await this.#owned(actor, serverId, importId))
  }

  /** Its owner answered what it asked: it is read again with the answer. */
  async answer(
    actor: Actor,
    serverId: string,
    importId: string,
    answer: WorldImportAnswerJson,
  ): Promise<WorldImportView> {
    const record = await this.#owned(actor, serverId, importId)
    if (record.status !== 'asking') return viewOf(record)
    const question = record.question ?? {}
    if (question.worlds !== undefined && !question.worlds.some((world) => world.folder === answer.folder))
      throw new AppError('invalid_choice', 'Choose one of the worlds in the file.')
    if (question.player && answer.player === undefined)
      throw new AppError(
        'invalid_choice',
        'Say which Minecraft account played this world, or that none should get it.',
      )
    const given = { ...(record.answer ?? {}), ...answer }
    await this.#db.transaction(async (tx) => {
      if (await worldImportAnswered(tx, record.id, given)) await this.#jobs.enqueueWorldImport(tx, record.id)
    })
    return viewOf((await loadWorldImport(this.#db, record.id)) ?? record)
  }

  /**
   * `world-import`: the upload fetched to this machine, opened as hostile input and never run, and
   * its world kept as a backup, or a question asked, or a refusal. The working copy goes whatever
   * happened; the upload goes once the import is done with it.
   */
  async runImport(importId: string): Promise<void> {
    const record = await loadWorldImport(this.#db, importId)
    if (record === null || record.status !== 'reading') return
    const work = await mkdtemp(join(tmpdir(), 'blockly-world-'))
    let pending: PendingUpload | null = null
    try {
      pending = await loadPendingUpload(this.#db, importId)
      if (pending === null) throw new Refused(SAID.neverArrived, 'no pending upload')
      const server = await findServer(this.#db, record.serverId)
      if (server === null || server.deletedAt !== null) throw new Refused(SAID.gone)
      await this.#bring(record, pending, server, work)
    } catch (error) {
      if (error instanceof Asks) {
        await worldImportAsks(this.#db, importId, error.question)
        return
      }
      if (!(error instanceof Refused)) throw error
      await worldImportRefused(this.#db, importId, {
        refusal: error.message,
        detail: error.detail,
        at: new Date(),
      })
      if (pending !== null) await this.#letGo(pending)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  /** The last attempt failed: its owner reads that it didn't work, and can upload it again. */
  async importGaveUp(importId: string, error: string): Promise<void> {
    await worldImportRefused(this.#db, importId, { refusal: SAID.gaveUp, detail: error, at: new Date() })
    const pending = await loadPendingUpload(this.#db, importId)
    if (pending !== null) await this.#letGo(pending)
  }

  async #owned(actor: Actor, serverId: string, importId: string): Promise<WorldImportRecord> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const record = await loadWorldImport(this.#db, importId)
    if (record === null || record.serverId !== server.id) throw new NotFound('Upload')
    return record
  }

  async #bring(record: WorldImportRecord, pending: PendingUpload, server: MinecraftServer, work: string) {
    const archive = await this.#reading.open(pending, work)
    try {
      const read = await this.#reading.read(archive, record.answer ?? {})
      const desired = await loadRevisionFields(this.#db, server.desiredRevisionId, [
        'gameVersion',
        'settings',
      ])
      await this.#reading.refuseWhatWontOpen(server, read, desired.gameVersion)
      const player = await this.#reading.hostPlayer(read, record.answer ?? {}, desired.settings.onlineMode)
      await this.#keep({ record, pending, server, read, player, serverVersion: desired.gameVersion })
    } finally {
      await archive.close()
    }
  }

  /**
   * The world kept as a backup of the server: the upload itself, where it already is a Cubepals
   * download of a world in its own name, else the world written again as the server keeps it.
   */
  async #keep(input: {
    record: WorldImportRecord
    pending: PendingUpload
    server: MinecraftServer
    read: Read
    player: { uuid: string; name: string } | null
    serverVersion: string
  }): Promise<void> {
    const { record, pending, server, read, player } = input
    const store = requireCapability(this.#caps, 'archives')
    const worlds = await listWorlds(this.#db, server.id)
    const fromCubepals = read.archive.kept.has(DOWNLOAD_NOTE)
    const known = worlds.find(
      (world) =>
        world.levelName === read.world.folderName &&
        (world.seed === null ? fromCubepals : world.seed === read.facts.seed),
    )
    const taken = worlds.map((world) => world.levelName)
    // Its own folder's name where that is one Blockly makes and no other world has it.
    const levelName =
      known?.levelName ??
      (isLevelName(read.world.folderName) && !taken.includes(read.world.folderName)
        ? read.world.folderName
        : nextLevelName(taken))
    // Only a download Cubepals made, as the gzipped tarball it made, is kept as it came: what else
    // it holds beside the world is what Cubepals put in it (`world-download.ts`). Its note is a file
    // anyone can add, so one holding what no download does (a jar) is written again.
    const asItCame =
      fromCubepals &&
      read.archive.files.every((file) => file.name === DOWNLOAD_NOTE || inWorldDownload(file.name)) &&
      read.archive.format === 'gzip' &&
      read.holds.properties === PROPERTIES_FILE &&
      read.world.folder === `${levelName}/` &&
      read.world.beside.every((folder) => folder.startsWith(`${levelName}_`)) &&
      player === null
    const names = read.archive.files.map((file) => file.name)
    const place = placeOnServer(read.world, levelName)
    const playerPath =
      player === null
        ? null
        : playerFilePath(names, read.world, levelName, read.facts.gameVersion, player.uuid)
    // Where the world already has a file of the account named, that file stays as the world had it.
    const hostWritten = playerPath !== null && !names.some((name) => place(name) === playerPath)
    const notes = [
      ...read.notes,
      ...this.#notes(read, levelName, player, hostWritten, input.serverVersion, asItCame),
    ]
    const backupId = randomUUID()
    let key = pending.key
    let sizeBytes = pending.sizeBytes
    if (!asItCame) {
      key = store.newKey('archive', { serverId: server.id, id: backupId })
      sizeBytes = await putStream(
        this.#archives.tarball(this.#placed(read, levelName, hostWritten ? playerPath : null)),
        await store.archiveTarget(key, LINK_SECONDS, 'browser'),
        mostOf(read.archive),
      )
    }
    const kept = await this.#record({
      record,
      pending,
      server,
      read,
      levelName,
      known: known?.id ?? null,
      backupId,
      key,
      sizeBytes,
      notes,
      serverVersion: input.serverVersion,
    }).catch(async (error: unknown) => {
      // A retry writes it again under a new key, so the one written here goes with the failure.
      if (!asItCame) await store.delete(key).catch(() => undefined)
      throw error
    })
    if (!kept && !asItCame) await store.delete(key)
    if (kept && !asItCame) await store.delete(pending.key).catch(() => undefined)
    // The upload was cleared while it was read (it waited past the day uploads are kept).
    if (!kept) throw new Refused(SAID.cleared, 'the pending upload was taken while the import ran')
  }

  /** What its owner reads Cubepals did, besides what reading found. */
  #notes(
    read: Read,
    levelName: string,
    player: { name: string } | null,
    hostWritten: boolean,
    serverVersion: string,
    asItCame: boolean,
  ): string[] {
    const notes: string[] = []
    const name = read.facts.name ?? read.world.folderName
    const folder = read.world.folder.slice(0, -1)
    // Said where it was found somewhere a player might not have looked: inside other folders, or
    // in one named otherwise.
    if (!asItCame && folder !== '' && (folder.includes('/') || folder !== name))
      notes.push(`Found “${name}” in ${folder}.`)
    if (player !== null)
      notes.push(
        hostWritten
          ? `Gave ${player.name} what they carried and where they stood in the single-player world.`
          : `${player.name} already had a player file in the world, which stays as it was.`,
      )
    const leftOut = leftOutOf(
      read.archive.files.map((file) => file.name),
      read.world,
    )
    if (!asItCame && leftOut.length > 0) notes.push(`Left out what isn’t the world: ${leftOut.join(', ')}.`)
    const modded = moddedBrands(read.facts)
    if (modded.length > 0)
      notes.push(
        `It was opened with ${modded.join(' and ')}. Blocks and items from its mods are only there on a server running the same mods.`,
      )
    if (!isRelease(read.facts.gameVersion))
      notes.push(
        `It was last played on the Minecraft snapshot ${read.facts.gameVersion}. A release older than that snapshot can’t open it.`,
      )
    else if (compareVersions(read.facts.gameVersion, serverVersion) < 0)
      notes.push(
        `It was last played on Minecraft ${read.facts.gameVersion}. Restoring it opens it on ${serverVersion}, which updates it; this backup stays as it came.`,
      )
    if (!asItCame && levelName !== read.world.folderName && read.world.folderName !== '')
      notes.push(`Its folder on the server is ${levelName}.`)
    return notes
  }

  /** The upload's world as the server keeps it, with the settings that name it and its host's file. */
  async *#placed(read: Read, levelName: string, hostFile: string | null): AsyncIterable<TarballEntry> {
    const properties = new TextEncoder().encode(`level-name=${levelName}\n`)
    yield { name: PROPERTIES_FILE, sizeBytes: properties.byteLength, data: properties }
    const place = placeOnServer(read.world, levelName)
    for await (const file of read.archive.entries()) {
      const to = place(file.name)
      if (to === null) {
        await file.data.cancel()
        continue
      }
      yield { name: to, sizeBytes: file.sizeBytes, data: file.data }
    }
    if (hostFile === null) return
    const playerPath = hostFile
    const own = await this.#formats.nbtPart(read.levelDat, ['Data', 'Player'])
    if (own !== null) yield { name: playerPath, sizeBytes: own.byteLength, data: own }
  }

  /**
   * The backup recorded, and the import ready: false where the upload was taken meanwhile (the
   * sweep let it go, or it was kept already), and nothing is recorded.
   */
  async #record(input: {
    record: WorldImportRecord
    pending: PendingUpload
    server: MinecraftServer
    read: Read
    levelName: string
    known: string | null
    backupId: string
    key: string
    sizeBytes: number
    notes: string[]
    serverVersion: string
  }): Promise<boolean> {
    const { record, read, server } = input
    const now = new Date()
    const standing = await loadStanding(this.#db, server.ownerId)
    const days = Math.max(
      entitlementsFor(standing.plan, standing.limitOverrides).backupPolicy.archiveRetentionDays,
      UPLOADED_KEPT_DAYS,
    )
    return this.#db.transaction(async (tx) => {
      const locked = await lockServer(tx, server.id)
      if (locked === null || !(await claimPendingUpload(tx, input.pending.id))) return false
      let worldId = input.known
      if (worldId === null) {
        worldId = (
          await insertWorld(tx, {
            serverId: locked.id,
            levelName: input.levelName,
            name: (record.name || read.facts.name || 'Uploaded world').slice(0, NAME_MAX_LENGTH),
            seed: read.facts.seed,
            levelType: read.facts.levelType,
            hardcore: read.facts.hardcore,
            generatedOnVersion: isRelease(read.facts.gameVersion)
              ? read.facts.gameVersion
              : input.serverVersion,
          })
        ).id
        // Not on the server until the backup is restored.
        await markWorldDeleted(tx, worldId, now)
        await markPruned(tx, [worldId], now)
      }
      await insertArchive(tx, {
        id: input.backupId,
        serverId: locked.id,
        worldId,
        revisionId: locked.desiredRevisionId,
        trigger: 'uploaded',
        status: 'ready',
        archiveKey: input.key,
        sizeBytes: input.sizeBytes,
        expiresAt: new Date(now.getTime() + days * DAY_MS),
        worldFacts: {
          seed: read.facts.seed,
          levelType: read.facts.levelType,
          hardcore: read.facts.hardcore,
          gameVersion: read.facts.gameVersion,
        },
      })
      await worldImportReady(tx, record.id, { backupId: input.backupId, notes: input.notes, at: now })
      await audit(tx, 'system', locked.id, 'server.world_uploaded', {
        backupId: input.backupId,
        importId: record.id,
        level: input.levelName,
      })
      await this.#events.publish(tx, { type: 'backup_changed', serverId: locked.id, ownerId: locked.ownerId })
      return true
    })
  }

  /** The upload is no longer needed: its file and its row go, unless the sweep took them first. */
  async #letGo(pending: PendingUpload): Promise<void> {
    const store = requireCapability(this.#caps, 'archives')
    if (await this.#db.transaction((tx) => claimPendingUpload(tx, pending.id)))
      await store.delete(pending.key)
  }
}

/** The most a world's tarball can come to: every file in full, with its header and padding. */
function mostOf(archive: WorldArchive): number {
  let bytes = 4 * 1024 * 1024
  for (const file of archive.files) bytes += file.sizeBytes + 3 * 512
  return Math.ceil(bytes * 1.01)
}

function viewOf(record: WorldImportRecord): WorldImportView {
  const base = { importId: record.id, fileName: record.fileName }
  switch (record.status) {
    case 'reading':
      return { status: 'reading', ...base }
    case 'asking':
      return {
        status: 'asking',
        ...base,
        worlds: record.question?.worlds ?? null,
        player: record.question?.player ?? false,
        problem: record.question?.problem ?? null,
      }
    case 'ready':
      return { status: 'ready', ...base, backupId: record.backupId as string, notes: record.notes }
    case 'refused':
      return { status: 'refused', ...base, message: record.refusal ?? SAID.gaveUp }
  }
}

async function audit(
  tx: Tx,
  actor: Actor | 'system',
  serverId: string,
  action: string,
  data: Record<string, unknown>,
) {
  await tx.insert(schema.auditLog).values({
    actor: actor === 'system' ? 'system:world-import' : requestedBy(actor),
    action,
    subjectType: 'server',
    subjectId: serverId,
    data,
  })
}

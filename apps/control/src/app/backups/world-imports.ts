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
import type { PeopleChoice, WorldImportView } from '@blockly/contracts'
import { NAME_MAX_LENGTH } from '@blockly/contracts'
import { type Db, schema, type Tx, type WorldImportAnswerJson, type WorldPeopleJson } from '@blockly/db'
import type { SeededAccess } from '../../domain/access/access.ts'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { PROPERTIES_FILE } from '../../minecraft/uploads.ts'
import { DOWNLOAD_NOTE, inWorldDownload } from '../../minecraft/world-download.ts'
import { placeOnServer, playerFilePath, withPlayersRenamed } from '../../minecraft/world-layout.ts'
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
import { listWorlds } from '../worlds/persistence.ts'
import { putStream } from './downloads.ts'
import { type KeptWorld, levelFor, othersNotes, recordKept } from './kept-worlds.ts'
import type { NewWorldImports } from './new-world-imports.ts'
import {
  insertWorldImport,
  loadWorldImport,
  type WorldImportRecord,
  worldImportAnswered,
  worldImportAsks,
  worldImportReady,
  worldImportRefused,
} from './world-import-records.ts'
import { accessFrom } from './world-people.ts'
import {
  type Accounts,
  Asks,
  accountNotes,
  answerFor,
  LINK_SECONDS,
  notesOn,
  peopleNotes,
  type Read,
  type ReadingDeps,
  Refused,
  SAID,
  viewOf,
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
  readonly #forNewServers: Pick<NewWorldImports, 'bring'>

  constructor(
    deps: ReadingDeps & {
      policy: AccessPolicy
      jobs: JobQueue
      events: EventBus
      /** Worlds brought while a server is being made, read by the same job. */
      forNewServers: Pick<NewWorldImports, 'bring'>
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
    this.#forNewServers = deps.forNewServers
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
    return viewOf(await this.#owned(actor, serverId, importId), asBackup)
  }

  /**
   * Who of the players of the server its world came from its owner lets in, as entries for the
   * server it was brought to (`AccessService.letIn`). Nobody where it came from no server.
   */
  async chosenPeople(
    actor: Actor,
    serverId: string,
    importId: string,
    choice: PeopleChoice,
  ): Promise<SeededAccess> {
    const record = await this.#owned(actor, serverId, importId)
    if (record.status !== 'ready') throw new AppError('invalid_choice', 'This world isn’t ready yet.')
    return record.people === null ? { whitelistOn: false, entries: [] } : accessFrom(record.people, choice)
  }

  /** Its owner answered what it asked: it is read again with the answer. */
  async answer(
    actor: Actor,
    serverId: string,
    importId: string,
    answer: WorldImportAnswerJson,
  ): Promise<WorldImportView> {
    const record = await this.#owned(actor, serverId, importId)
    if (record.status !== 'asking') return viewOf(record, asBackup)
    const given = answerFor(record, answer)
    await this.#db.transaction(async (tx) => {
      if (await worldImportAnswered(tx, record.id, given)) await this.#jobs.enqueueWorldImport(tx, record.id)
    })
    return viewOf((await loadWorldImport(this.#db, record.id)) ?? record, asBackup)
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
      await this.#bringTo(record, pending, work)
    } catch (error) {
      if (error instanceof Asks) {
        await worldImportAsks(this.#db, importId, error.question)
        return
      }
      if (!(error instanceof Refused)) throw error
      await this.#refuse(importId, { refusal: error.message, detail: error.detail }, pending)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  /** The last attempt failed: its owner reads that it didn't work, and can upload it again. */
  async importGaveUp(importId: string, error: string): Promise<void> {
    await this.#refuse(
      importId,
      { refusal: SAID.gaveUp, detail: error },
      await loadPendingUpload(this.#db, importId),
    )
  }

  async #owned(actor: Actor, serverId: string, importId: string): Promise<WorldImportRecord> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const record = await loadWorldImport(this.#db, importId)
    if (record === null || record.serverId !== server.id) throw new NotFound('Upload')
    return record
  }

  /** The world brought to its server, or, brought while its server is being made, kept for it. */
  async #bringTo(record: WorldImportRecord, pending: PendingUpload, work: string): Promise<void> {
    if (record.serverId === null) return this.#forNewServers.bring(record, pending, work)
    const server = await findServer(this.#db, record.serverId)
    if (server === null || server.deletedAt !== null) throw new Refused(SAID.gone)
    await this.#bring(record, pending, server, work)
  }

  async #bring(record: WorldImportRecord, pending: PendingUpload, server: MinecraftServer, work: string) {
    const archive = await this.#reading.open(pending, work)
    try {
      const read = await this.#reading.read(archive, record.answer ?? {})
      const desired = await loadRevisionFields(this.#db, server.desiredRevisionId, [
        'gameVersion',
        'settings',
      ])
      await this.#reading.refuseWhatWontOpen(
        { ownerId: server.ownerId, serverId: server.id },
        read,
        desired.gameVersion,
      )
      const player = await this.#reading.hostPlayer(read, record.answer ?? {}, desired.settings.onlineMode)
      const others = await this.#reading.others(
        read,
        { ownerId: server.ownerId, serverId: server.id },
        desired.gameVersion,
      )
      const accounts = await this.#reading.accounts(read, desired.settings.onlineMode, others.reads)
      const people = await this.#reading.people(read, desired.settings.onlineMode)
      await this.#keep({
        record,
        pending,
        server,
        read,
        player,
        accounts,
        people,
        others,
        serverVersion: desired.gameVersion,
      })
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
    /** An offline-mode server's players, moved to their accounts where the server plays online. */
    accounts: Accounts
    /** Who could join the server it came from, for its owner to choose from. */
    people: WorldPeopleJson | null
    /** The upload's other worlds, each kept as a backup of its own, and those left out. */
    others: { reads: Read[]; left: string[] }
    serverVersion: string
  }): Promise<void> {
    const { record, pending, server, read, player, accounts } = input
    const store = requireCapability(this.#caps, 'archives')
    const worlds = await listWorlds(this.#db, server.id)
    const fromCubepals = read.archive.kept.has(DOWNLOAD_NOTE)
    const taken = worlds.map((world) => world.levelName)
    const { levelName, known } = levelFor(read, worlds, taken, fromCubepals)
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
      player === null &&
      accounts.renames.size === 0
    const names = read.archive.files.map((file) => file.name)
    const place = withPlayersRenamed(placeOnServer(read.world, levelName), accounts.renames)
    const playerPath =
      player === null
        ? null
        : playerFilePath(names, read.world, levelName, read.facts.gameVersion, player.uuid)
    // Where the world already has a file of the account named, that file stays as the world had it.
    const hostWritten = playerPath !== null && !names.some((name) => place(name) === playerPath)
    const notes = [
      ...read.notes,
      ...notesOn(read, {
        levelName,
        player,
        hostWritten,
        asItCame,
        updated: (from) =>
          `It was last played on Minecraft ${from}. Restoring it opens it on ${input.serverVersion}, which updates it; this backup stays as it came.`,
        serverVersion: input.serverVersion,
        others: input.others.reads.map((other) => other.world),
      }),
      ...accountNotes(accounts),
      ...peopleNotes(input.people),
      ...othersNotes(input.others.reads, input.others.left),
    ]
    const backupId = randomUUID()
    let key = pending.key
    let sizeBytes = pending.sizeBytes
    if (!asItCame) {
      key = store.newKey('archive', { serverId: server.id, id: backupId })
      sizeBytes = await putStream(
        this.#archives.tarball(this.#placed(read, levelName, place, hostWritten ? playerPath : null)),
        await store.archiveTarget(key, LINK_SECONDS, 'browser'),
        mostOf(read.archive),
      )
    }
    // Written after the world itself, which a failure among them takes with it.
    const others = await this.#keptOthers(
      server,
      input.others.reads,
      worlds,
      [...taken, levelName],
      accounts,
    ).catch(async (error: unknown) => {
      if (!asItCame) await store.delete(key).catch(() => undefined)
      throw error
    })
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
      people: input.people,
      others,
      serverVersion: input.serverVersion,
    }).catch(async (error: unknown) => {
      // A retry writes them again under new keys, so the ones written here go with the failure.
      for (const written of [...others.map((other) => other.key), ...(asItCame ? [] : [key])])
        await store.delete(written).catch(() => undefined)
      throw error
    })
    if (!kept) for (const other of others) await store.delete(other.key)
    if (!kept && !asItCame) await store.delete(key)
    if (kept && !asItCame) await store.delete(pending.key).catch(() => undefined)
    // The upload was cleared while it was read (it waited past the day uploads are kept).
    if (!kept) throw new Refused(SAID.cleared, 'the pending upload was taken while the import ran')
  }

  /** The upload's world as the server keeps it, with the settings that name it and its host's file. */
  async *#placed(
    read: Read,
    levelName: string,
    place: (path: string) => string | null,
    hostFile: string | null,
  ): AsyncIterable<TarballEntry> {
    const properties = new TextEncoder().encode(`level-name=${levelName}\n`)
    yield { name: PROPERTIES_FILE, sizeBytes: properties.byteLength, data: properties }
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
    people: WorldPeopleJson | null
    /** The upload's other worlds, written as backups of their own. */
    others: KeptWorld[]
    serverVersion: string
  }): Promise<boolean> {
    const { record, server } = input
    const now = new Date()
    const standing = await loadStanding(this.#db, server.ownerId)
    const days = Math.max(
      entitlementsFor(standing.plan, standing.limitOverrides).backupPolicy.archiveRetentionDays,
      UPLOADED_KEPT_DAYS,
    )
    const at = { now, days, serverVersion: input.serverVersion }
    return this.#db.transaction(async (tx) => {
      const locked = await lockServer(tx, server.id)
      if (locked === null || !(await claimPendingUpload(tx, input.pending.id))) return false
      await recordKept(tx, locked, { ...input, name: record.name }, at)
      for (const other of input.others) await recordKept(tx, locked, other, at)
      await worldImportReady(tx, record.id, {
        backupId: input.backupId,
        people: input.people,
        notes: input.notes,
        at: now,
      })
      await audit(tx, 'system', locked.id, 'server.world_uploaded', {
        backupId: input.backupId,
        importId: record.id,
        level: input.levelName,
        ...(input.others.length > 0 ? { others: input.others.map((other) => other.levelName) } : {}),
      })
      await this.#events.publish(tx, { type: 'backup_changed', serverId: locked.id, ownerId: locked.ownerId })
      return true
    })
  }

  /** The upload's other worlds written as the server keeps them, each in a folder of its own. */
  async #keptOthers(
    server: MinecraftServer,
    reads: readonly Read[],
    worlds: Parameters<typeof levelFor>[1],
    taken: string[],
    accounts: Accounts,
  ): Promise<KeptWorld[]> {
    const store = requireCapability(this.#caps, 'archives')
    const kept: KeptWorld[] = []
    try {
      for (const other of reads) {
        const { levelName, known } = levelFor(other, worlds, taken, false)
        taken.push(levelName)
        const backupId = randomUUID()
        const key = store.newKey('archive', { serverId: server.id, id: backupId })
        const place = withPlayersRenamed(placeOnServer(other.world, levelName), accounts.renames)
        const sizeBytes = await putStream(
          this.#archives.tarball(this.#placed(other, levelName, place, null)),
          await store.archiveTarget(key, LINK_SECONDS, 'browser'),
          mostOf(other.archive),
        )
        kept.push({
          read: other,
          levelName,
          known: known?.id ?? null,
          name: other.world.folderName || null,
          backupId,
          key,
          sizeBytes,
        })
      }
    } catch (error) {
      for (const written of kept) await store.delete(written.key).catch(() => undefined)
      throw error
    }
    return kept
  }

  /**
   * Refused, and its upload no longer needed: the refusal and the upload's row in one write, so the
   * owner who reads it refused finds nothing of it kept, then its file, unless the sweep took them first.
   */
  async #refuse(
    importId: string,
    result: { refusal: string; detail?: string | undefined },
    pending: PendingUpload | null,
  ): Promise<void> {
    const claimed = await this.#db.transaction(async (tx) => {
      await worldImportRefused(tx, importId, { ...result, at: new Date() })
      return pending !== null && (await claimPendingUpload(tx, pending.id))
    })
    if (claimed && pending !== null) await requireCapability(this.#caps, 'archives').delete(pending.key)
  }
}

/** The most a world's tarball can come to: every file in full, with its header and padding. */
function mostOf(archive: WorldArchive): number {
  let bytes = 4 * 1024 * 1024
  for (const file of archive.files) bytes += file.sizeBytes + 3 * 512
  return Math.ceil(bytes * 1.01)
}

/** A world brought to a server is ready as the backup it became. */
const asBackup = (record: WorldImportRecord) => ({
  backupId: record.backupId as string,
  people: record.people,
})

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

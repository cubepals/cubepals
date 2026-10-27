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
import { DAY_MS, HOUR_S } from '@blockly/contracts/durations'
import {
  type Db,
  schema,
  type Tx,
  type WorldImportAnswerJson,
  type WorldImportQuestionJson,
} from '@blockly/db'
import {
  comesWith,
  entitlementsFor,
  planThatRuns,
  worldRoomBytes,
} from '../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { nextLevelName } from '../../domain/world/world.ts'
import { PROPERTIES_FILE } from '../../minecraft/uploads.ts'
import { compareVersions, isRelease } from '../../minecraft/versions.ts'
import { DOWNLOAD_NOTE, inWorldDownload, jarsInNote } from '../../minecraft/world-download.ts'
import { moddedBrands, type WorldFacts, worldFacts } from '../../minecraft/world-facts.ts'
import {
  chosenWorld,
  type FoundWorld,
  leftOutOf,
  modsBeside,
  placeOnServer,
  playerFilePath,
  type UploadHolds,
  uploadHolds,
  worldGenSettingsPaths,
} from '../../minecraft/world-layout.ts'
import { isLevelName } from '../../minecraft/worlds.ts'
import { identityFor } from '../access/identity.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { EventBus } from '../ports/events.ts'
import {
  type FileFormats,
  HostileArchive,
  type PackArchives,
  type TarballEntry,
  UnreadableFile,
  type WorldArchive,
  type WorldArchives,
} from '../ports/formats.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'
import { findServer, grownStorage, lockServer } from '../servers/persistence.ts'
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

/** Reading and writing a world of a few gigabytes takes a while; the links outlast it. */
const LINK_SECONDS = 2 * HOUR_S
/** An uploaded world stays at least this long, whatever the plan keeps, so there is time to restore it. */
const UPLOADED_KEPT_DAYS = 7
/** What opening an upload holds it to: more files and bytes than a world has, not more. */
const LIMITS = {
  maxFiles: 500_000,
  maxFileBytes: 4 * 1024 ** 3,
  maxTotalBytes: 64 * 1024 ** 3,
  maxKeptBytes: 32 * 1024 * 1024,
}
/** The few files an upload is read by: what each world says of itself, and its server's settings. */
const KEPT =
  /(^|\/)(level\.dat|level\.dat_old|server\.properties|world_gen_settings\.dat|cubepals-download\.txt)$/

const SAID = {
  neverArrived: 'The file never arrived. Upload it again.',
  notAnArchive:
    'This file isn’t a zip or a .tar.gz, or it was cut short. Zip the world’s folder and upload that.',
  hostile: 'Cubepals can’t open this file safely. Zip the world’s folder again and upload that.',
  tooLarge: 'This world is larger than any Cubepals server holds.',
  bedrock:
    'This is a Bedrock world. A Cubepals server plays Java worlds, which Bedrock players join too, and can’t open a Bedrock save.',
  noWorld: 'There’s no world in this file. Upload the world’s own folder, the one with level.dat in it.',
  gaveUp: 'Cubepals couldn’t finish reading this world. Try uploading it again.',
  gone: 'This server is gone.',
  cleared: 'The upload was cleared before Cubepals finished reading it. Upload it again.',
}

/** Why an import ends without a world: the sentence its owner reads, and what an admin reads. */
class Refused extends Error {
  readonly detail: string | undefined
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'Refused'
    this.detail = detail
  }
}

/** A question for its owner, and the world it is about where one was chosen. */
class Asks extends Error {
  readonly question: WorldImportQuestionJson
  constructor(question: WorldImportQuestionJson) {
    super('asks its owner')
    this.name = 'Asks'
    this.question = question
  }
}

/** What reading an upload found, before anything is written. */
interface Read {
  archive: WorldArchive
  holds: Extract<UploadHolds, { kind: 'java' }>
  world: FoundWorld
  facts: WorldFacts
  levelDat: Uint8Array
  notes: string[]
}

export class WorldImports {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #formats: FileFormats
  readonly #archives: PackArchives & WorldArchives
  readonly #jobs: JobQueue
  readonly #events: EventBus
  readonly #profiles: PlayerProfiles

  constructor(deps: {
    db: Db
    policy: AccessPolicy
    capabilities: DeploymentCapabilities
    formats: FileFormats
    archives: PackArchives & WorldArchives
    jobs: JobQueue
    events: EventBus
    profiles: PlayerProfiles
  }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#formats = deps.formats
    this.#archives = deps.archives
    this.#jobs = deps.jobs
    this.#events = deps.events
    this.#profiles = deps.profiles
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
    if (arrived === null) throw new AppError('invalid_upload', SAID.neverArrived)
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
    const store = requireCapability(this.#caps, 'archives')
    const link = await store.presignGet(pending.key, LINK_SECONDS, 'browser')
    const path = join(work, 'upload')
    await this.#archives.fetchTo(link.url, path, pending.sizeBytes).catch((error: unknown) => {
      if (error instanceof HostileArchive) throw new Refused(SAID.tooLarge, error.message)
      throw error
    })
    const archive = await this.#archives
      .openWorld(path, { ...LIMITS, keep: (name) => KEPT.test(name) })
      .catch((error: unknown) => {
        if (error instanceof HostileArchive)
          throw new Refused(error.reason === 'too_large' ? SAID.tooLarge : SAID.hostile, error.message)
        if (error instanceof UnreadableFile) throw new Refused(SAID.notAnArchive, error.message)
        throw error
      })
    try {
      const read = await this.#read(archive, record.answer ?? {})
      const desired = await loadRevisionFields(this.#db, server.desiredRevisionId, [
        'gameVersion',
        'settings',
      ])
      await this.#refuseWhatWontOpen(server, read, desired.gameVersion)
      const player = await this.#hostPlayer(read, record.answer ?? {}, desired.settings.onlineMode)
      await this.#keep({ record, pending, server, read, player, serverVersion: desired.gameVersion })
    } finally {
      await archive.close()
    }
  }

  /** The world in the upload and what it says, or the question that chooses it. */
  async #read(archive: WorldArchive, answer: WorldImportAnswerJson): Promise<Read> {
    const names = archive.files.map((file) => file.name)
    const holds = uploadHolds(names)
    if (holds.kind === 'bedrock') throw new Refused(SAID.bedrock)
    if (holds.kind === 'nothing') throw new Refused(SAID.noWorld)
    const properties = holds.properties === null ? null : this.#properties(archive, holds.properties)
    const chosen =
      answer.folder !== undefined
        ? (holds.worlds.find((world) => world.folder === answer.folder) ?? null)
        : chosenWorld(holds, properties?.['level-name']?.trim() || 'world')
    if (chosen === null) throw new Asks({ worlds: await this.#choices(archive, holds.worlds) })
    const notes: string[] = []
    const levelDat = archive.kept.get(chosen.levelDat)
    if (levelDat === undefined) throw new Refused(SAID.noWorld)
    if (chosen.levelDat.endsWith('_old'))
      notes.push('Its level.dat was missing, so Cubepals used the copy Minecraft keeps beside it.')
    const level = await this.#formats.decodeNbt(levelDat).catch(() => {
      throw new Refused(`The world’s ${chosen.levelDat.split('/').pop()} can’t be read.`)
    })
    const genPath = worldGenSettingsPaths(chosen).find((path) => archive.kept.has(path))
    const gen =
      genPath === undefined
        ? undefined
        : await this.#formats.decodeNbt(archive.kept.get(genPath) as Uint8Array).catch(() => undefined)
    const fromServer = holds.properties !== null && chosen.folder !== '' && properties !== null
    const facts = worldFacts(level, gen, fromServer ? properties : null)
    if ('refused' in facts) throw new Refused(facts.refused)
    return { archive, holds, world: chosen, facts, levelDat, notes }
  }

  #properties(archive: WorldArchive, path: string): Record<string, string> | null {
    const raw = archive.kept.get(path)
    if (raw === undefined) return null
    try {
      return this.#formats.decode('properties', new TextDecoder().decode(raw)) as Record<string, string>
    } catch {
      return null
    }
  }

  /** The worlds an upload holds, by what each says it is, for its owner to choose from. */
  async #choices(
    archive: WorldArchive,
    worlds: readonly FoundWorld[],
  ): Promise<NonNullable<WorldImportQuestionJson['worlds']>> {
    return Promise.all(
      worlds.slice(0, 50).map(async (world) => {
        const raw = archive.kept.get(world.levelDat)
        const facts =
          raw === undefined
            ? null
            : worldFacts(await this.#formats.decodeNbt(raw).catch(() => null), undefined, null)
        const known = facts !== null && !('refused' in facts) ? facts : null
        return {
          folder: world.folder,
          name: known?.name ?? world.folderName ?? 'World',
          gameVersion: known?.gameVersion ?? null,
        }
      }),
    )
  }

  /** What would open wrongly, or not at all, on this server: refused before anything is written. */
  async #refuseWhatWontOpen(server: MinecraftServer, read: Read, serverVersion: string): Promise<void> {
    // A snapshot's name says nothing of the releases around it, so it is never called newer.
    if (isRelease(read.facts.gameVersion) && compareVersions(read.facts.gameVersion, serverVersion) > 0)
      throw new Refused(
        `This world was last played on Minecraft ${read.facts.gameVersion}, newer than this server's ${serverVersion}. Move the server to ${read.facts.gameVersion} first, then try again.`,
      )
    const note = read.archive.kept.get(DOWNLOAD_NOTE)
    const jars = [
      ...modsBeside(
        read.archive.files.map((file) => file.name),
        read.world,
      ),
      ...(note === undefined ? [] : jarsInNote(new TextDecoder().decode(note))).filter((jar) =>
        jar.startsWith('mods/'),
      ),
    ]
    const standing = await loadStanding(this.#db, server.ownerId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    // Held to the room an upload is (`beginWorldUpload`), as the world lies on disk, not as it was sent.
    const room = worldRoomBytes(Math.max(plan.storage.mostGb, await grownStorage(this.#db, server.id)))
    const place = placeOnServer(read.world, 'world')
    const unpacked = read.archive.files.reduce(
      (sum, file) => (place(file.name) === null ? sum : sum + file.sizeBytes),
      0,
    )
    if (unpacked > room)
      throw new Refused(
        `This world is ${gigabytes(unpacked)} GB unpacked, and this server has room for a world of up to ${gigabytes(room)} GB.`,
      )
    // A world made with mods is never opened on plain Minecraft on a plan without them: it would
    // lose every modded block and item without a word.
    if (jars.length > 0 && !plan.mayUseMods)
      throw new Refused(
        comesWith('Worlds made with mods', planThatRuns({ tier: '3g', loader: 'fabric', modded: true })),
      )
  }

  /**
   * The account a single-player world's host played it on, whose own data goes to their player
   * file: asked of its owner, who may say none. Null where there is no host, or none is to get it.
   */
  async #hostPlayer(
    read: Read,
    answer: WorldImportAnswerJson,
    onlineMode: boolean,
  ): Promise<{ uuid: string; name: string } | null> {
    if (!read.facts.hostPlayer) return null
    if (answer.player === undefined) throw new Asks({ player: true })
    if (answer.player === null) return null
    const player = await identityFor(answer.player, onlineMode, this.#profiles, null)
    if (player === null)
      throw new Asks({ player: true, problem: `No Minecraft account is called ${answer.player}.` })
    return player
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

/** Bytes as the sentences about room say them: gigabytes, to a tenth. */
const gigabytes = (bytes: number): number => Number((bytes / 1024 ** 3).toFixed(1))

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

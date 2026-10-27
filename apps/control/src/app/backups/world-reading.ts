// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** An uploaded world read as hostile input: its world found, what it says, what to ask, what refuses it. */
import { join } from 'node:path'
import type { WorldImportView } from '@blockly/contracts'
import { HOUR_S } from '@blockly/contracts/durations'
import type { Db, WorldImportAnswerJson, WorldImportQuestionJson } from '@blockly/db'
import {
  broughtWorldRoomBytes,
  comesWith,
  entitlementsFor,
  planThatRuns,
  worldRoomBytes,
} from '../../domain/account/entitlements.ts'
import { compareVersions, isRelease } from '../../minecraft/versions.ts'
import { DOWNLOAD_NOTE, jarsInNote } from '../../minecraft/world-download.ts'
import { moddedBrands, type WorldFacts, worldFacts } from '../../minecraft/world-facts.ts'
import {
  chosenWorld,
  type FoundWorld,
  leftOutOf,
  modsBeside,
  placeOnServer,
  type UploadHolds,
  uploadHolds,
  worldGenSettingsPaths,
} from '../../minecraft/world-layout.ts'
import { identityFor } from '../access/identity.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError } from '../errors.ts'
import {
  type FileFormats,
  HostileArchive,
  type PackArchives,
  UnreadableFile,
  type WorldArchive,
  type WorldArchives,
} from '../ports/formats.ts'
import type { PlayerProfiles } from '../ports/minecraft.ts'
import { grownStorage } from '../servers/persistence.ts'
import type { PendingUpload } from '../uploads/persistence.ts'
import type { WorldImportRecord } from './world-import-records.ts'

/** Reading and writing a world of a few gigabytes takes a while; the links outlast it. */
export const LINK_SECONDS = 2 * HOUR_S
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

export const SAID = {
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

/** A world upload can be as large as one upload to the store takes. */
export const MAX_WORLD_BYTES = 4 * 1024 ** 3
/** The largest world upload a disk of `diskGb` has room for. */
export const worldUploadLimit = (diskGb: number): number => Math.min(MAX_WORLD_BYTES, worldRoomBytes(diskGb))

/** The mods an upload has beside its world, or a Cubepals download names: none for plain Minecraft. */
export function modJars(read: Read): string[] {
  const note = read.archive.kept.get(DOWNLOAD_NOTE)
  return [
    ...modsBeside(
      read.archive.files.map((file) => file.name),
      read.world,
    ),
    ...(note === undefined ? [] : jarsInNote(new TextDecoder().decode(note))).filter((jar) =>
      jar.startsWith('mods/'),
    ),
  ]
}

/** Bytes as the sentences about room say them: gigabytes, to a tenth. */
const gigabytes = (bytes: number): number => Number((bytes / 1024 ** 3).toFixed(1))

/** Why an import ends without a world: the sentence its owner reads, and what an admin reads. */
export class Refused extends Error {
  readonly detail: string | undefined
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'Refused'
    this.detail = detail
  }
}

/** A question for its owner, and the world it is about where one was chosen. */
export class Asks extends Error {
  readonly question: WorldImportQuestionJson
  constructor(question: WorldImportQuestionJson) {
    super('asks its owner')
    this.name = 'Asks'
    this.question = question
  }
}

/** What reading an upload found, before anything is written. */
export interface Read {
  archive: WorldArchive
  holds: Extract<UploadHolds, { kind: 'java' }>
  world: FoundWorld
  facts: WorldFacts
  levelDat: Uint8Array
  notes: string[]
}

export interface ReadingDeps {
  db: Db
  capabilities: DeploymentCapabilities
  formats: FileFormats
  archives: PackArchives & WorldArchives
  profiles: PlayerProfiles
}

export class WorldReading {
  readonly #db: Db
  readonly #caps: DeploymentCapabilities
  readonly #formats: FileFormats
  readonly #archives: PackArchives & WorldArchives
  readonly #profiles: PlayerProfiles

  constructor(deps: ReadingDeps) {
    this.#db = deps.db
    this.#caps = deps.capabilities
    this.#formats = deps.formats
    this.#archives = deps.archives
    this.#profiles = deps.profiles
  }

  /** The upload fetched to `work` and opened, or why it can't be. */
  async open(pending: PendingUpload, work: string): Promise<WorldArchive> {
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
    return archive
  }

  /** The world in the upload and what it says, or the question that chooses it. */
  async read(archive: WorldArchive, answer: WorldImportAnswerJson): Promise<Read> {
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

  /**
   * What would open wrongly, or not at all, on the server it goes to (`serverId`, or one its owner
   * is making): refused before anything is written.
   */
  async refuseWhatWontOpen(
    to: { ownerId: string; serverId: string | null },
    read: Read,
    serverVersion: string,
  ): Promise<void> {
    // A snapshot's name says nothing of the releases around it, so it is never called newer.
    if (isRelease(read.facts.gameVersion) && compareVersions(read.facts.gameVersion, serverVersion) > 0)
      throw new Refused(
        `This world was last played on Minecraft ${read.facts.gameVersion}, newer than this server's ${serverVersion}. Move the server to ${read.facts.gameVersion} first, then try again.`,
      )
    const jars = modJars(read)
    const standing = await loadStanding(this.#db, to.ownerId)
    const plan = entitlementsFor(standing.plan, standing.limitOverrides)
    // Held to the room an upload is (`beginWorldUpload`), as the world lies on disk, not as it was sent.
    // A new server's first start unpacks it beside its archive (`diskForBroughtWorld`).
    const room =
      to.serverId === null
        ? broughtWorldRoomBytes(plan.storage.mostGb)
        : worldRoomBytes(Math.max(plan.storage.mostGb, await grownStorage(this.#db, to.serverId)))
    const place = placeOnServer(read.world, 'world')
    const unpacked = read.archive.files.reduce(
      (sum, file) => (place(file.name) === null ? sum : sum + file.sizeBytes),
      0,
    )
    if (unpacked > room)
      throw new Refused(
        `This world is ${gigabytes(unpacked)} GB unpacked, and ${to.serverId === null ? 'a server on your plan' : 'this server'} has room for a world of up to ${gigabytes(room)} GB.`,
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
  async hostPlayer(
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
}

/**
 * Why a world can't be uploaded under this name, before it is sent; null where it can. A world
 * comes as a zip or a tarball, gzipped or not; Bedrock's own files and other archivers' are named.
 */
export function refusedByName(fileName: string): string | null {
  if (/\.(zip|tar|tar\.gz|tgz)$/i.test(fileName)) return null
  if (/\.(mcworld|mcpack|mcaddon|mctemplate)$/i.test(fileName))
    return 'This is a Bedrock world. A Cubepals server plays Java worlds, which Bedrock players join too, and can’t open a Bedrock save.'
  if (/\.(rar|7z)$/i.test(fileName))
    return 'Cubepals can’t open this kind of file. Zip the world’s folder and upload that.'
  return 'Upload the world as a zip of its folder, or as the .tar.gz a server download comes as.'
}

/** An owner's answer to what an import asked, with what they said before: refused where it doesn't answer it. */
export function answerFor(record: WorldImportRecord, answer: WorldImportAnswerJson): WorldImportAnswerJson {
  const question = record.question ?? {}
  if (question.worlds !== undefined && !question.worlds.some((world) => world.folder === answer.folder))
    throw new AppError('invalid_choice', 'Choose one of the worlds in the file.')
  if (question.player && answer.player === undefined)
    throw new AppError(
      'invalid_choice',
      'Say which Minecraft account played this world, or that none should get it.',
    )
  return { ...(record.answer ?? {}), ...answer }
}

/** An import as its owner sees it: being read, asking, ready as `ready` says, or refused and why. */
export function viewOf<Ready extends object>(
  record: WorldImportRecord,
  ready: (record: WorldImportRecord) => Ready,
): ImportViewOf<Ready> {
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
      return { status: 'ready', ...base, notes: record.notes, ...ready(record) }
    case 'refused':
      return { status: 'refused', ...base, message: record.refusal ?? SAID.gaveUp }
  }
}

/** What `viewOf` makes of an import, ready as `Ready`: `WorldImportView` and `NewWorldImportView`. */
type ImportViewOf<Ready> = { importId: string; fileName: string } & (
  | { status: 'reading' }
  | Pick<Extract<WorldImportView, { status: 'asking' }>, 'status' | 'worlds' | 'player' | 'problem'>
  | ({ status: 'ready'; notes: string[] } & Ready)
  | { status: 'refused'; message: string }
)

/**
 * What its owner reads Cubepals did, besides what reading found. `levelName` is the world's folder
 * on a server that has others, null on a new one; `updated` says a world from an older release is
 * opened on the server's, `serverVersion`.
 */
export function notesOn(
  read: Read,
  how: {
    levelName: string | null
    player: { name: string } | null
    hostWritten: boolean
    asItCame: boolean
    serverVersion: string
    updated: (from: string) => string
  },
): string[] {
  const notes: string[] = []
  const name = read.facts.name ?? read.world.folderName
  const folder = read.world.folder.slice(0, -1)
  // Said where it was found somewhere a player might not have looked: inside other folders, or
  // in one named otherwise.
  if (!how.asItCame && folder !== '' && (folder.includes('/') || folder !== name))
    notes.push(`Found “${name}” in ${folder}.`)
  if (how.player !== null)
    notes.push(
      how.hostWritten
        ? `Gave ${how.player.name} what they carried and where they stood in the single-player world.`
        : `${how.player.name} already had a player file in the world, which stays as it was.`,
    )
  const leftOut = leftOutOf(
    read.archive.files.map((file) => file.name),
    read.world,
  )
  if (!how.asItCame && leftOut.length > 0) notes.push(`Left out what isn’t the world: ${leftOut.join(', ')}.`)
  const modded = moddedBrands(read.facts)
  if (modded.length > 0)
    notes.push(
      `It was opened with ${modded.join(' and ')}. Blocks and items from its mods are only there on a server running the same mods.`,
    )
  if (!isRelease(read.facts.gameVersion))
    notes.push(
      `It was last played on the Minecraft snapshot ${read.facts.gameVersion}. A release older than that snapshot can’t open it.`,
    )
  else if (compareVersions(read.facts.gameVersion, how.serverVersion) < 0)
    notes.push(how.updated(read.facts.gameVersion))
  if (
    !how.asItCame &&
    how.levelName !== null &&
    how.levelName !== read.world.folderName &&
    read.world.folderName !== ''
  )
    notes.push(`Its folder on the server is ${how.levelName}.`)
  return notes
}

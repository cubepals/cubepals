// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** An uploaded world read as hostile input: its world found, what it says, what to ask, what refuses it. */
import { join } from 'node:path'
import type { WorldImportView } from '@blockly/contracts'
import { HOUR_S } from '@blockly/contracts/durations'
import type { Db, WorldImportAnswerJson, WorldImportQuestionJson, WorldPeopleJson } from '@blockly/db'
import {
  broughtWorldRoomBytes,
  comesWith,
  entitlementsFor,
  planThatRuns,
  worldRoomBytes,
} from '../../domain/account/entitlements.ts'
import { NAME_CACHE } from '../../minecraft/access.ts'
import { normalizeUuid } from '../../minecraft/console.ts'
import { compareVersions, isRelease } from '../../minecraft/versions.ts'
import { DOWNLOAD_NOTE, jarsInNote } from '../../minecraft/world-download.ts'
import { moddedBrands, type WorldFacts, worldFacts } from '../../minecraft/world-facts.ts'
import {
  chosenWorld,
  type FoundWorld,
  leftOutOf,
  modsBeside,
  placeOnServer,
  playersWithFiles,
  type UploadHolds,
  uploadHolds,
  worldGenSettingsPaths,
} from '../../minecraft/world-layout.ts'
import { identityFor, offlineUuid } from '../access/identity.ts'
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
import { peopleOf } from './world-people.ts'

/** Reading and writing a world of a few gigabytes takes a while; the links outlast it. */
export const LINK_SECONDS = 2 * HOUR_S
/** Where in `work` an upload is fetched to and read from. */
export const uploadIn = (work: string): string => join(work, 'upload')
/** What opening an upload holds it to: more files and bytes than a world has, not more. */
const LIMITS = {
  maxFiles: 500_000,
  maxFileBytes: 4 * 1024 ** 3,
  maxTotalBytes: 64 * 1024 ** 3,
  maxKeptBytes: 32 * 1024 * 1024,
}
/** The few files an upload is read by: what each world says of itself, its server's settings and who joined it. */
const KEPT =
  /(^|\/)(level\.dat|level\.dat_old|server\.properties|world_gen_settings\.dat|cubepals-download\.txt|usercache\.json|whitelist\.json|ops\.json|banned-players\.json)$/
/** How many of an offline-mode server's players are looked up as accounts: a large server's regulars. */
const MOST_ACCOUNTS = 200

/** How many of a server's other worlds an upload brings: more than a server with several has. */
const MOST_OTHER_WORLDS = 16

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

/** A world as it lies on disk once unpacked, its Nether and End beside it included. */
function unpackedBytes(read: Read): number {
  const place = placeOnServer(read.world, 'world')
  return read.archive.files.reduce((sum, file) => (place(file.name) === null ? sum : sum + file.sizeBytes), 0)
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

  /** The upload fetched to `work` (`uploadIn`) and opened, or why it can't be. */
  async open(pending: PendingUpload, work: string): Promise<WorldArchive> {
    const store = requireCapability(this.#caps, 'archives')
    const link = await store.presignGet(pending.key, LINK_SECONDS, 'browser')
    const path = uploadIn(work)
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
   * is making): refused before anything is written. The room a world has there, where it opens.
   */
  async refuseWhatWontOpen(
    to: { ownerId: string; serverId: string | null },
    read: Read,
    serverVersion: string,
  ): Promise<number> {
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
    const unpacked = unpackedBytes(read)
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
    return room
  }

  /**
   * The players of an offline-mode server, moved to their Minecraft accounts (docs/world-import.md
   * § How Blockly reads it, 6): each name in the server's `usercache.json` whose UUID is the one the
   * server made up from it, and who has files in the world, looked up as an account. Their files'
   * new names, who was matched, and who has no account by that name, whose files stay as they are.
   * `others` are the server's other worlds kept with it, whose players are its players too.
   * None for a server that plays in offline mode itself, where the names stay the server's.
   */
  async accounts(read: Read, onlineMode: boolean, others: readonly Read[] = []): Promise<Accounts> {
    const accounts: Accounts = { renames: new Map(), matched: [], unmatched: [], kept: [], beyond: 0 }
    const properties = read.holds.properties
    if (properties === null || !onlineMode) return accounts
    const raw = read.archive.kept.get(`${properties.slice(0, properties.lastIndexOf('/') + 1)}${NAME_CACHE}`)
    if (raw === undefined) return accounts
    // Their files in every world kept, the server's other worlds' too.
    const names = read.archive.files.map((file) => file.name)
    const present = new Set([read, ...others].flatMap((one) => playersWithFiles(names, one.world)))
    const offline = usercacheOf(raw).filter(
      (one) => one.uuid === offlineUuid(one.name) && present.has(one.uuid),
    )
    // Each file name a player has, or is given: two can't land on one.
    const taken = new Set(present)
    accounts.beyond = Math.max(0, offline.length - MOST_ACCOUNTS)
    for (const one of offline.slice(0, MOST_ACCOUNTS)) {
      // A lookup that fails throws, and the read is tried again: only Mojang's own "nobody" is no account.
      const profile = await this.#profiles.byName(one.name)
      if (profile === null) {
        accounts.unmatched.push(one.name)
        continue
      }
      const uuid = normalizeUuid(profile.uuid).toLowerCase()
      // The account has files of its own in the world, or another name came to it first: those stay.
      if (taken.has(uuid)) {
        accounts.kept.push(one.name)
        continue
      }
      taken.add(uuid)
      accounts.renames.set(one.uuid, uuid)
      accounts.matched.push(profile.name)
    }
    return accounts
  }

  /**
   * The upload's other worlds, beside the one brought, as a server with several keeps them: each
   * read on its own, and one that wouldn't open on the server it goes to left out, saying why.
   */
  async others(
    read: Read,
    to: { ownerId: string; serverId: string | null },
    serverVersion: string,
  ): Promise<{ reads: Read[]; left: string[] }> {
    const reads: Read[] = []
    const left: string[] = []
    // Only a server's: the other saves of a saves folder are the player's to choose from, one at a time.
    if (read.holds.properties === null) return { reads, left }
    let total = unpackedBytes(read)
    for (const world of read.holds.worlds.slice(0, MOST_OTHER_WORLDS)) {
      if (world.folder === read.world.folder) continue
      try {
        const other = await this.read(read.archive, { folder: world.folder })
        const room = await this.refuseWhatWontOpen(to, other, serverVersion)
        // Kept together, they fit where one world would: many large ones aren't many times the room.
        if (total + unpackedBytes(other) > room)
          throw new Refused(
            `with the worlds before it, it is more than the ${gigabytes(room)} GB of worlds this server has room for.`,
          )
        total += unpackedBytes(other)
        reads.push(other)
      } catch (error) {
        if (!(error instanceof Refused)) throw error
        left.push(`Left out ${world.folderName || 'a world'}: ${error.message}`)
      }
    }
    return { reads, left }
  }

  /** Who could join the server the upload came from, named as one checking accounts or not knows them. */
  people(read: Read, onlineMode: boolean): Promise<WorldPeopleJson | null> {
    return peopleOf(read, onlineMode, this.#profiles)
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

/** An offline-mode server's players, moved to their accounts (`WorldReading.accounts`). */
export interface Accounts {
  /** Each player's files' UUID, the one the server made up, to their account's. */
  renames: Map<string, string>
  matched: string[]
  /** Names no Minecraft account has, whose files stay as they are. */
  unmatched: string[]
  /** Names whose account already has files in the world, which stay, as theirs do. */
  kept: string[]
  /** How many more players there were than are looked up, whose files stay as they are. */
  beyond: number
}

/** The names and UUIDs a server's `usercache.json` lists, dashed and lowercase; none where it can't be read. */
function usercacheOf(raw: Uint8Array): Array<{ name: string; uuid: string }> {
  try {
    const listed: unknown = JSON.parse(new TextDecoder().decode(raw))
    if (!Array.isArray(listed)) return []
    // A player listed twice is one player.
    const players = new Map<string, { name: string; uuid: string }>()
    for (const entry of listed) {
      const { name, uuid } = (entry ?? {}) as { name?: unknown; uuid?: unknown }
      if (typeof name !== 'string' || typeof uuid !== 'string') continue
      const id = normalizeUuid(uuid).toLowerCase()
      if (!players.has(id)) players.set(id, { name, uuid: id })
    }
    return [...players.values()]
  } catch {
    return []
  }
}

/** What its owner reads of an offline-mode server's players moved to their accounts. */
export function accountNotes(accounts: Accounts): string[] {
  return [
    ...(accounts.matched.length > 0
      ? [
          `Moved ${accounts.matched.length === 1 ? 'a player' : `${accounts.matched.length} players`} of the offline-mode server to their Minecraft accounts, with what they carried and their stats: ${accounts.matched.join(', ')}.`,
        ]
      : []),
    ...(accounts.unmatched.length > 0
      ? [
          `No Minecraft account is called ${accounts.unmatched.join(', ')}, so their files stay as the offline-mode server kept them.`,
        ]
      : []),
    ...(accounts.kept.length > 0
      ? [
          `${accounts.kept.join(', ')} already had files under their Minecraft account in the world, so both stay as they were.`,
        ]
      : []),
    ...(accounts.beyond > 0
      ? [
          `Cubepals moves the first ${MOST_ACCOUNTS} players of an offline-mode server to their accounts; the files of the ${accounts.beyond} more stay as the server kept them.`,
        ]
      : []),
  ]
}

/** What its owner reads of the players in its server's files that no account has. */
export function peopleNotes(people: WorldPeopleJson | null): string[] {
  if (people === null || people.unknown.length === 0) return []
  return [
    `No Minecraft account is called ${people.unknown.join(', ')}, so they aren’t among its players to let in.`,
  ]
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
    /** The upload's other worlds, kept or named on their own. */
    others?: readonly FoundWorld[]
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
  // The server's other worlds are said of their own (`kept-worlds.ts`).
  const others = (how.others ?? []).flatMap((world) => [world.folder, ...world.beside])
  const rest = leftOut.filter(
    (name) => !others.some((folder) => folder === name || folder.endsWith(`/${name}`)),
  )
  if (!how.asItCame && rest.length > 0) notes.push(`Left out what isn’t the world: ${rest.join(', ')}.`)
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

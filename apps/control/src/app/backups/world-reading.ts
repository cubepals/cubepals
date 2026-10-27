// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** An uploaded world read as hostile input: its world found, what it says, what to ask, what refuses it. */
import { join } from 'node:path'
import { HOUR_S } from '@blockly/contracts/durations'
import type { Db, WorldImportAnswerJson, WorldImportQuestionJson } from '@blockly/db'
import {
  comesWith,
  entitlementsFor,
  planThatRuns,
  worldRoomBytes,
} from '../../domain/account/entitlements.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { compareVersions, isRelease } from '../../minecraft/versions.ts'
import { DOWNLOAD_NOTE, jarsInNote } from '../../minecraft/world-download.ts'
import { type WorldFacts, worldFacts } from '../../minecraft/world-facts.ts'
import {
  chosenWorld,
  type FoundWorld,
  modsBeside,
  placeOnServer,
  type UploadHolds,
  uploadHolds,
  worldGenSettingsPaths,
} from '../../minecraft/world-layout.ts'
import { identityFor } from '../access/identity.ts'
import { loadStanding } from '../accounts/persistence.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
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

  /** What would open wrongly, or not at all, on this server: refused before anything is written. */
  async refuseWhatWontOpen(server: MinecraftServer, read: Read, serverVersion: string): Promise<void> {
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

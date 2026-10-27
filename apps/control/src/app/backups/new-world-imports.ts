// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world its owner brings while making a server (docs/world-import.md): uploaded before the
 * server exists, read as any world upload is (`world-reading.ts`), and packed as the archive the
 * new server's first start unpacks where its world goes (`minecraft/starter.ts`), with what the
 * server is made to fit: the release, the game mode, the difficulty. Making the server from it is
 * `setups/service.ts`'s and `servers/new-server.ts`'s; a world brought to a server that exists is
 * `world-imports.ts`'s, whose job reads this one too.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { NewWorldImportView } from '@blockly/contracts'
import { DAY_MS, HOUR_S } from '@blockly/contracts/durations'
import type { Db, NewWorldFactsJson, Tx, WorldImportAnswerJson } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { ModArtifact } from '../../domain/mods/artifact.ts'
import { releaseFor } from '../../minecraft/versions.ts'
import { moddedBrands } from '../../minecraft/world-facts.ts'
import { placeInLevel, playerFilePath } from '../../minecraft/world-layout.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import { recordStored } from '../artifacts/persistence.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import type { FileFormats, PackArchives, TarballEntry, WorldArchives } from '../ports/formats.ts'
import type { JobQueue } from '../ports/jobs.ts'
import { tuning } from '../tuning.ts'
import {
  claimPendingUpload,
  insertPendingUpload,
  loadPendingUpload,
  type PendingUpload,
} from '../uploads/persistence.ts'
import {
  insertWorldImport,
  loadWorldImport,
  newWorldImportReady,
  type WorldImportRecord,
  worldImportAnswered,
  worldsBroughtBefore,
  worldsBroughtSince,
} from './world-import-records.ts'
import {
  answerFor,
  MAX_WORLD_BYTES,
  modJars,
  notesOn,
  type Read,
  type ReadingDeps,
  Refused,
  refusedByName,
  SAID,
  viewOf,
  WorldReading,
  worldUploadLimit,
} from './world-reading.ts'

/** Uploading a large world takes a while; the link only has to be valid when it starts. */
const UPLOAD_LINK_SECONDS = HOUR_S
/** The archive's name, as the step fetches it (`minecraft/starter.ts`). */
const ARCHIVE_NAME = 'world.tar.gz'
/** A new server's world: its first, so the folder every new server's world has. */
const LEVEL = 'world'

/** A world brought for a new server, as making the server uses it. */
/** Refused past the worlds its owner may bring in a day (`AbuseLimits.worldUploadsPerDay`). */
async function withinADay(tx: Tx, ownerId: string): Promise<void> {
  const since = new Date(Date.now() - DAY_MS)
  if ((await worldsBroughtSince(tx, ownerId, since)) >= tuning().abuse.worldUploadsPerDay)
    throw new AppError('rate_limited', 'That’s a lot of worlds for one day. Try again tomorrow.')
}

/** What a world played with mods is told on the create page, where a server is made from it alone. */
const PLAYED_WITH_MODS =
  'This world was played with mods, and a server made from it alone runs plain Minecraft, which would lose its modded blocks and items. Make the server from the pack it was played with, under “A pack you have”, then bring the world on that server’s World page.'

export interface BroughtWorld {
  facts: NewWorldFactsJson
  /** The archive the server's first start unpacks where its world goes. */
  startsOn: ModArtifact
}

export class NewWorldImports {
  readonly #db: Db
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #formats: FileFormats
  readonly #archives: PackArchives & WorldArchives
  readonly #jobs: JobQueue
  readonly #reading: WorldReading

  constructor(deps: ReadingDeps & { policy: AccessPolicy; jobs: JobQueue }) {
    this.#db = deps.db
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#formats = deps.formats
    this.#archives = deps.archives
    this.#jobs = deps.jobs
    this.#reading = new WorldReading(deps)
  }

  /**
   * Where the browser sends the world, before a server is made: held to the largest disk a server
   * on its owner's plan can have, as a world uploaded to a server is.
   */
  async begin(
    actor: UserActor,
    file: { fileName: string; sizeBytes: number },
  ): Promise<{ ticket: string; url: string; headers: Record<string, string> }> {
    const fileName = (file.fileName.split(/[\\/]/).pop() ?? '').trim()
    const refused = refusedByName(fileName)
    if (refused !== null) throw new AppError('invalid_upload', refused)
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > MAX_WORLD_BYTES)
      throw new AppError('invalid_upload', 'A world can be up to 4 GB.')
    return this.#db.transaction(async (tx) => {
      const standing = await loadStanding(tx, actor.userId)
      const limit = worldUploadLimit(entitlementsFor(standing.plan, standing.limitOverrides).storage.mostGb)
      if (file.sizeBytes > limit)
        throw new AppError(
          'invalid_upload',
          `A server on your plan has room for a world of up to ${Number((limit / 1024 ** 3).toFixed(1))} GB.`,
        )
      await this.#policy.require(tx, actor.userId, { kind: 'restore_archive' })
      await withinADay(tx, actor.userId)
      const store = requireCapability(this.#caps, 'archives')
      const id = randomUUID()
      const key = store.newKey('world_upload', { serverId: '', id })
      await insertPendingUpload(tx, {
        id,
        ownerId: actor.userId,
        serverId: null,
        kind: 'world',
        key,
        fileName: fileName.slice(0, 200),
        sizeBytes: file.sizeBytes,
        sha512: null,
      })
      const target = await store.presignPut(key, UPLOAD_LINK_SECONDS, 'browser', file.sizeBytes)
      return { ticket: id, url: target.url, headers: target.headers }
    })
  }

  /**
   * The upload arrived: it is read on a worker, and `view` says how it went. Asked twice, once. Its
   * owner holds one world for a server not yet made: the one before it goes once this one is ready
   * (`#keep`), so a world that is refused or never picked leaves the one before as it was.
   */
  async finish(actor: UserActor, ticket: string): Promise<{ importId: string }> {
    const known = await loadWorldImport(this.#db, ticket)
    if (known !== null && known.ownerId === actor.userId && known.serverId === null)
      return { importId: known.id }
    const pending = await this.#pending(actor, ticket)
    const arrived = await requireCapability(this.#caps, 'archives').head(pending.key)
    if (arrived === null) throw new AppError('invalid_upload', SAID.neverArrived)
    if (arrived.sizeBytes !== pending.sizeBytes)
      throw new AppError('invalid_upload', 'The file didn’t arrive whole. Upload it again.')
    await this.#db.transaction(async (tx) => {
      // Asked again as it is read: tickets taken before any was finished count once they are.
      await withinADay(tx, actor.userId)
      const made = await insertWorldImport(tx, {
        id: pending.id,
        ownerId: actor.userId,
        serverId: null,
        fileName: pending.fileName,
        sizeBytes: pending.sizeBytes,
        name: null,
      })
      if (made) await this.#jobs.enqueueWorldImport(tx, pending.id)
    })
    return { importId: pending.id }
  }

  /** An import as its owner sees it: being read, asking, ready as what it is, or refused and why. */
  async view(actor: UserActor, importId: string): Promise<NewWorldImportView> {
    return viewOf(await this.#owned(actor, importId), asWorld)
  }

  /** Its owner answered what it asked: it is read again with the answer. */
  async answer(
    actor: UserActor,
    importId: string,
    answer: WorldImportAnswerJson,
  ): Promise<NewWorldImportView> {
    const record = await this.#owned(actor, importId)
    if (record.status !== 'asking') return viewOf(record, asWorld)
    const given = answerFor(record, answer)
    await this.#db.transaction(async (tx) => {
      if (await worldImportAnswered(tx, record.id, given)) await this.#jobs.enqueueWorldImport(tx, record.id)
    })
    return viewOf((await loadWorldImport(this.#db, record.id)) ?? record, asWorld)
  }

  /**
   * The `world-import` job's part for a world with no server yet: read, refused where no server
   * Cubepals makes could open it, and packed for the one its owner makes. The job's own part
   * (`world-imports.ts`) says what a question or a refusal does.
   */
  async bring(record: WorldImportRecord, pending: PendingUpload, work: string): Promise<void> {
    const archive = await this.#reading.open(pending, work)
    try {
      const read = await this.#reading.read(archive, record.answer ?? {})
      const playsOn = releaseFor(read.facts.gameVersion)
      if (playsOn === null)
        throw new Refused(
          `This world was last played on Minecraft ${read.facts.gameVersion}, newer than any release Cubepals offers yet.`,
        )
      await this.#reading.refuseWhatWontOpen({ ownerId: record.ownerId, serverId: null }, read, playsOn)
      // A server made from a world alone runs plain Minecraft, which would lose a modded world's
      // blocks and items: it is made from its pack, and the world brought to it after.
      if (moddedBrands(read.facts).length > 0 || modJars(read).length > 0) throw new Refused(PLAYED_WITH_MODS)
      // A new server plays in online mode, so the account named is the one Mojang says.
      const player = await this.#reading.hostPlayer(read, record.answer ?? {}, true)
      await this.#keep(record, pending, read, player, playsOn, work)
    } finally {
      await archive.close()
    }
  }

  /** The world packed and stored under its bytes, and the import ready for its server. */
  async #keep(
    record: WorldImportRecord,
    pending: PendingUpload,
    read: Read,
    player: { uuid: string; name: string } | null,
    playsOn: string,
    work: string,
  ): Promise<void> {
    const store = requireCapability(this.#caps, 'archives')
    const names = read.archive.files.map((file) => file.name)
    const place = placeInLevel(read.world)
    const levelPath =
      player === null ? null : playerFilePath(names, read.world, LEVEL, read.facts.gameVersion, player.uuid)
    const hostFile = levelPath === null ? null : levelPath.slice(`${LEVEL}/`.length)
    // Where the world already has a file of the account named, that file stays as the world had it.
    const hostWritten = hostFile !== null && !names.some((name) => place(name) === hostFile)
    const packed = await this.#pack(read, hostWritten ? hostFile : null, join(work, ARCHIVE_NAME))
    const key = await store.ingestFile(packed.path, packed.sha512)
    // Recorded at once: should what follows fail, the store's sweep finds it unused and lets it go.
    await recordStored(this.#db, { sha512: packed.sha512, key, sizeBytes: packed.sizeBytes, source: 'built' })
    const startsOn: ModArtifact = {
      ref: { kind: 'stored', key },
      sha512: packed.sha512,
      sizeBytes: packed.sizeBytes,
      fileName: ARCHIVE_NAME,
    }
    const facts: NewWorldFactsJson = {
      name: (read.facts.name ?? read.world.folderName) || null,
      gameVersion: read.facts.gameVersion,
      playsOn,
      seed: read.facts.seed,
      levelType: read.facts.levelType,
      hardcore: read.facts.hardcore,
      gameMode: read.facts.gameMode,
      difficulty: read.facts.difficulty,
      sizeBytes: read.archive.files.reduce(
        (sum, file) => (place(file.name) === null ? sum : sum + file.sizeBytes),
        0,
      ),
    }
    const notes = [
      ...read.notes,
      ...notesOn(read, {
        levelName: null,
        player,
        hostWritten,
        asItCame: false,
        serverVersion: playsOn,
        updated: (from) =>
          `It was last played on Minecraft ${from}. Its server runs ${playsOn}, which updates it when it first starts.`,
      }),
    ]
    const kept = await this.#db.transaction(async (tx) => {
      if (!(await claimPendingUpload(tx, pending.id))) return false
      await newWorldImportReady(tx, record.id, { facts, startsOn, notes, at: new Date() })
      await worldsBroughtBefore(tx, record.ownerId, record.id)
      return true
    })
    // The upload was cleared while it was read (it waited past the day uploads are kept). What was
    // stored is the store's sweep's to let go: its bytes may be another import's too.
    if (!kept) throw new Refused(SAID.cleared, 'the pending upload was taken while the import ran')
    await store.delete(pending.key).catch(() => undefined)
  }

  /**
   * The world as the step unpacks it into the world's folder, written here as a gzipped tarball, and
   * its bytes' sha512 as they were written.
   */
  async #pack(
    read: Read,
    hostFile: string | null,
    path: string,
  ): Promise<{ path: string; sha512: string; sizeBytes: number }> {
    const hash = createHash('sha512')
    let sizeBytes = 0
    await pipeline(
      this.#archives.tarball(this.#inLevel(read, hostFile)),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk)
          sizeBytes += chunk.length
          done(null, chunk)
        },
      }),
      createWriteStream(path),
    )
    return { path, sha512: hash.digest('hex'), sizeBytes }
  }

  /** The upload's world inside its own folder, and its host's own file where they get one. */
  async *#inLevel(read: Read, hostFile: string | null): AsyncIterable<TarballEntry> {
    const place = placeInLevel(read.world)
    for await (const file of read.archive.entries()) {
      const to = place(file.name)
      if (to === null) await file.data.cancel()
      else yield { name: to, sizeBytes: file.sizeBytes, data: file.data }
    }
    if (hostFile === null) return
    const own = await this.#formats.nbtPart(read.levelDat, ['Data', 'Player'])
    if (own !== null) yield { name: hostFile, sizeBytes: own.byteLength, data: own }
  }

  async #pending(actor: UserActor, ticket: string): Promise<PendingUpload> {
    const pending = await loadPendingUpload(this.#db, ticket)
    if (
      pending === null ||
      pending.kind !== 'world' ||
      pending.ownerId !== actor.userId ||
      pending.serverId !== null
    )
      throw new NotFound('Upload')
    return pending
  }

  async #owned(actor: UserActor, importId: string): Promise<WorldImportRecord> {
    return ownedBy(this.#db, actor.userId, importId)
  }
}

/** A world its owner brought while making a server, by its import; no one else's. */
async function ownedBy(db: Db, ownerId: string, importId: string): Promise<WorldImportRecord> {
  const record = await loadWorldImport(db, importId)
  if (record === null || record.ownerId !== ownerId || record.serverId !== null) throw new NotFound('Upload')
  return record
}

/**
 * The world a server is being made from (`setups/service.ts`), ready: refused where it isn't yet,
 * or where Cubepals no longer keeps it.
 */
export async function broughtWorld(db: Db, ownerId: string, importId: string): Promise<BroughtWorld> {
  const record = await ownedBy(db, ownerId, importId)
  if (record.status !== 'ready' || record.facts === null)
    throw new AppError('invalid_choice', 'This world isn’t ready yet.')
  if (record.startsOn === null)
    throw new AppError('invalid_choice', 'Cubepals no longer keeps this world. Upload it again.')
  return { facts: record.facts, startsOn: record.startsOn }
}

/** A world brought for a new server is ready as what it is, and what its server plays it on. */
const asWorld = (record: WorldImportRecord) => ({
  world: {
    name: record.facts?.name ?? record.name ?? 'Your world',
    gameVersion: record.facts?.gameVersion ?? '',
    playsOn: record.facts?.playsOn ?? '',
  },
})

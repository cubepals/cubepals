import { createHash, randomUUID } from 'node:crypto'
import { type Db, schema } from '@blockly/db'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type {
  CatalogHit,
  CatalogProject,
  CatalogVersion,
  ProjectState,
  VersionState,
} from '../../domain/mods/catalog.ts'
import {
  type CatalogData,
  type ModConflict,
  type ResolveRequest,
  resolve,
} from '../../domain/mods/resolve.ts'
import {
  defaultSettings,
  type Loader,
  runsOnPaper,
  type ServerRevision,
} from '../../domain/revision/revision.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { catalogLoadersFor, projectTypesFor, serverEnvironment } from '../../minecraft/mods.ts'
import {
  fits,
  JAR_MANIFEST,
  JAR_METADATA,
  type JarMetadataFile,
  jarFileName,
  type ModMetadata,
  modMetadata,
  type VersionRange,
} from '../../minecraft/uploads.ts'
import { compareVersions, loaderForMods, offeredVersions, supports } from '../../minecraft/versions.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { recordStored } from '../artifacts/persistence.ts'
import { type DeploymentCapabilities, requireCapability } from '../capabilities.ts'
import { revokedIn } from '../catalog/persistence.ts'
import type { CatalogSync, CatalogTransition } from '../catalog/sync.ts'
import { AppError, NotFound } from '../errors.ts'
import type { AccessPolicy } from '../policy/access-policy.ts'
import { CatalogUnavailable, type ModCatalog } from '../ports/catalog.ts'
import { type FileFormats, UnreadableFile } from '../ports/formats.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import { loaderPin, paperPin } from '../revisions/pins.ts'
import { type ChangeOptions, playsNoPack, type RevisionService } from '../revisions/service.ts'
import { findServer, loadRevision } from '../servers/persistence.ts'
import {
  deletePendingUpload,
  finishPendingUpload,
  insertPendingUpload,
  loadPendingUpload,
} from '../uploads/persistence.ts'
import {
  deleteModUpload,
  findModUpload,
  insertModUpload,
  loadModUploads,
  type ModUploadRecord,
  uploadInUse,
} from './uploads.ts'

/** A change to a server's mods, as the owner asks for it. */
export interface ModChange {
  /** `dir` is where a template puts a plugin's jar, when not the loader's own folder (`PinnedMod.dir`). */
  add?:
    | ReadonlyArray<{ projectId: string; versionId?: string | undefined; dir?: string | undefined }>
    | undefined
  /** The owner's own uploads, by upload id. */
  addUploads?: readonly string[] | undefined
  /** Projects, or uploads by their upload id. */
  remove?: readonly string[] | undefined
  upgrade?: readonly string[] | 'all' | undefined
  /**
   * Apply the change on a newer release, moving the world there: the owner accepting the move
   * a refused plan offered. Worlds only move forward, so this is never Blockly's own decision.
   */
  moveTo?: string | undefined
}

/** What a change would make of the server's mods, before anything is written. */
export type ModPlan =
  | {
      kind: 'ok'
      /** The revision the plan starts from; applying it from any other is refused. */
      basedOn: string
      mods: PinnedMod[]
      added: PinnedMod[]
      removed: PinnedMod[]
      updated: Array<{ from: PinnedMod; to: PinnedMod }>
      /** Mods taken down where they were published, which the owner must choose to run anyway. */
      revoked: PinnedMod[]
    }
  | {
      kind: 'conflicts'
      conflicts: ModConflict[]
      /** A newer Minecraft Blockly offers where the same change works; null when none does. */
      movesTo?: { gameVersion: string }
    }

/** Resolution asks for more of the catalog in rounds; a dependency chain deeper than this is not real. */
const MAX_ROUNDS = 12

/** How many newer releases a refused change is tried against, smallest move first. */
const NEWER_RELEASES_TRIED = 3

/** The largest jar Blockly takes: bigger than any mod, smaller than a mistake. */
const MAX_JAR_BYTES = 128 * 1024 * 1024
/** A browser starts sending at once; the link is signed for the size it said. */
const UPLOAD_LINK_SECONDS = 15 * 60
/** Long enough to read the bytes back and copy them into place. */
const READ_LINK_SECONDS = 10 * 60
const SHA512 = /^[0-9a-f]{128}$/

/** Where an upload's first half leaves off: a link to put the jar at, or the upload already made. */
export type UploadStart =
  | { kind: 'known'; upload: ModUploadRecord }
  | { kind: 'upload'; ticket: string; url: string; headers: Record<string, string> }

/**
 * The mods a server runs (§15.5): search while authoring, then every change resolved against
 * the catalog as one set, shown before it's applied, and applied as a revision. Nothing partial:
 * a set that can't run together is a list of conflicts, and nothing changes.
 */
export class ModService {
  readonly #db: Db
  readonly #catalog: ModCatalog
  readonly #sync: CatalogSync
  readonly #revisions: RevisionService
  readonly #policy: AccessPolicy
  readonly #caps: DeploymentCapabilities
  readonly #formats: FileFormats
  readonly #catalogMoved: (transitions: readonly CatalogTransition[]) => Promise<void>
  readonly #builds: LoaderBuilds

  constructor(deps: {
    db: Db
    catalog: ModCatalog
    sync: CatalogSync
    revisions: RevisionService
    policy: AccessPolicy
    capabilities: DeploymentCapabilities
    formats: FileFormats
    /** Listings that pin what moved re-evaluate (§15.3); the listing service does that. */
    catalogMoved: (transitions: readonly CatalogTransition[]) => Promise<void>
    loaderBuilds: LoaderBuilds
  }) {
    this.#db = deps.db
    this.#catalog = deps.catalog
    this.#sync = deps.sync
    this.#revisions = deps.revisions
    this.#policy = deps.policy
    this.#caps = deps.capabilities
    this.#formats = deps.formats
    this.#catalogMoved = deps.catalogMoved
    this.#builds = deps.loaderBuilds
  }

  /**
   * The first half of a custom upload (§15.2): a link the browser puts the jar at, signed for the
   * size it said. Bytes this owner uploaded before are known already and need no second upload.
   */
  async beginUpload(
    actor: Actor,
    serverId: string,
    file: { fileName: string; sizeBytes: number; sha512: string },
  ): Promise<UploadStart> {
    const fileName = jarFileName(file.fileName)
    if (fileName === null) throw new AppError('invalid_upload', 'Mods and plugins are .jar files.')
    const sha512 = file.sha512.toLowerCase()
    if (!SHA512.test(sha512))
      throw new AppError('invalid_upload', 'The file’s fingerprint came out wrong. Try again.')
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > MAX_JAR_BYTES)
      throw new AppError('invalid_upload', `A jar can be up to ${MAX_JAR_BYTES / 1024 / 1024} MB.`)
    return this.#db.transaction(async (tx) => {
      const server = authorize(actor, await findServer(tx, serverId))
      await this.#policy.require(tx, server.ownerId, { kind: 'upload_mod' })
      const store = requireCapability(this.#caps, 'archives')
      const known = await findModUpload(tx, server.ownerId, sha512)
      if (known !== null) return { kind: 'known', upload: known }
      const id = randomUUID()
      const key = store.newKey('mod_upload', { serverId: server.id, id })
      await insertPendingUpload(tx, {
        id,
        ownerId: server.ownerId,
        serverId: server.id,
        kind: 'mod',
        key,
        fileName,
        sizeBytes: file.sizeBytes,
        sha512,
      })
      const target = await store.presignPut(key, UPLOAD_LINK_SECONDS, 'browser', file.sizeBytes)
      return { kind: 'upload', ticket: id, url: target.url, headers: target.headers }
    })
  }

  /**
   * The second half: the jar is read back and checked (whole, the bytes the browser hashed, a mod
   * or plugin a server can run), copied under its hash, and recorded as the owner's upload.
   * Uploads are never trusted, whatever they say about themselves (§15.3).
   */
  async finishUpload(actor: Actor, serverId: string, ticket: string): Promise<ModUploadRecord> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const pending = await loadPendingUpload(this.#db, ticket)
    if (
      pending === null ||
      pending.kind !== 'mod' ||
      pending.serverId !== server.id ||
      pending.finishedAt !== null
    )
      throw new NotFound('Upload')
    await this.#db.transaction((tx) => this.#policy.require(tx, server.ownerId, { kind: 'upload_mod' }))
    const store = requireCapability(this.#caps, 'archives')
    const arrived = await store.head(pending.key)
    if (arrived === null) throw new AppError('invalid_upload', 'The file never arrived. Upload it again.')
    if (arrived.sizeBytes !== pending.sizeBytes)
      throw new AppError('invalid_upload', 'The file didn’t arrive whole. Upload it again.')
    const link = await store.presignGet(pending.key, READ_LINK_SECONDS, 'browser')
    const bytes = await readAll(link.url, pending.sizeBytes)
    const sha512 = createHash('sha512').update(bytes).digest('hex')
    if (sha512 !== pending.sha512)
      throw new AppError('invalid_upload', 'The file changed on its way here. Upload it again.')
    const metadata = this.#readJar(bytes)
    // A jar the catalog publishes is judged by where the catalog says it runs, which is right more
    // often than the jar's own word (docs/modpack-system.md § Sides). An outage leaves the jar's.
    const published = (await this.#catalog.filesByHash([sha512]).catch(() => null))?.get(sha512)
    if (
      published !== undefined &&
      published.version.environment !== 'unknown' &&
      serverEnvironment(published.version.environment) === null
    )
      throw new AppError('invalid_upload', `${metadata.name} only runs in players’ games, not on a server.`)
    const key = await store.ingestFromUrl(link.url, sha512)

    const upload = await this.#db.transaction(async (tx) => {
      await recordStored(tx, { sha512, key, sizeBytes: bytes.length, source: 'upload' })
      const id =
        (await findModUpload(tx, pending.ownerId, sha512))?.id ??
        (await insertModUpload(tx, {
          ownerId: pending.ownerId,
          sha512,
          fileName: pending.fileName,
          metadata,
        }))
      await finishPendingUpload(tx, pending.id, new Date())
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: 'mods.uploaded',
        subjectType: 'server',
        subjectId: server.id,
        data: { uploadId: id, sha512, fileName: pending.fileName },
      })
      const [record] = await loadModUploads(tx, [id])
      if (record === undefined) throw new Error('The upload just recorded is missing')
      return record
    })
    // The staging copy goes now if it can; otherwise artifact-gc deletes it.
    await store
      .delete(pending.key)
      .then(() => deletePendingUpload(this.#db, pending.id))
      .catch(() => undefined)
    return upload
  }

  /** An upload no server runs any more; one that is still pinned can't go (§15.2). */
  async deleteUpload(actor: Actor, serverId: string, uploadId: string): Promise<void> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    const [upload] = await loadModUploads(this.#db, [uploadId])
    if (upload === undefined || upload.ownerId !== server.ownerId) throw new NotFound('Upload')
    if (await uploadInUse(this.#db, uploadId))
      throw new AppError('invalid_choice', 'A server still has this upload. Remove it from its mods first.')
    await deleteModUpload(this.#db, uploadId)
  }

  /** What a jar says about itself, or why a server can't run it. */
  #readJar(bytes: Uint8Array): ModMetadata {
    const names = [...(Object.keys(JAR_METADATA) as JarMetadataFile[]), JAR_MANIFEST]
    let files: Record<string, string>
    try {
      files = this.#formats.unzip(bytes, names)
    } catch (error) {
      if (error instanceof UnreadableFile)
        throw new AppError('invalid_upload', 'This file isn’t a whole jar.')
      throw error
    }
    const decoded: Partial<Record<JarMetadataFile, unknown>> = {}
    for (const [name, format] of Object.entries(JAR_METADATA) as Array<
      [JarMetadataFile, (typeof JAR_METADATA)[JarMetadataFile]]
    >) {
      const text = files[name]
      if (text === undefined) continue
      try {
        decoded[name] = this.#formats.decode(format, text)
      } catch (error) {
        if (error instanceof UnreadableFile)
          throw new AppError('invalid_upload', `The jar’s ${name} can’t be read: ${error.message}`)
        throw error
      }
    }
    const metadata = modMetadata(decoded, files[JAR_MANIFEST])
    if (metadata === null)
      throw new AppError(
        'invalid_upload',
        'This jar isn’t a mod or plugin Cubepals can read: it has no fabric.mod.json, mods.toml or plugin.yml.',
      )
    if (metadata.environment === 'client')
      throw new AppError('invalid_upload', `${metadata.name} only runs in players’ games, not on a server.`)
    return metadata
  }

  /**
   * Mods, or plugins for Paper, that have a version for this server's game version and type,
   * each saying whether any of its versions runs on a server at all. One that doesn't is never
   * suggested before anybody types, since the downloads that rank it are players'; searched for
   * by name, it is listed, so it doesn't seem missing.
   */
  async search(
    actor: Actor,
    serverId: string,
    query: { text: string; offset: number; limit: number },
  ): Promise<{ hits: Array<CatalogHit & { runsOnServers: boolean }>; total: number }> {
    const { desired } = await this.#load(actor, serverId)
    // A vanilla world searches for what it would run once it has a mod: the owner never picks a
    // server type, so the search is against the one Blockly would move it to.
    const loader = runningLoader(desired)
    const projectTypes = projectTypesFor(loader)
    if (projectTypes.length === 0) return { hits: [], total: 0 }
    const found = await this.#reading(() =>
      this.#catalog.search({
        text: query.text,
        target: { gameVersion: desired.gameVersion, loaders: catalogLoadersFor(loader) },
        projectTypes,
        offset: query.offset,
        limit: query.limit,
      }),
    )
    const browsing = query.text.trim() === ''
    const hits = found.hits.map((hit) => ({
      ...hit,
      runsOnServers:
        hit.environments.length === 0 || hit.environments.some((e) => serverEnvironment(e) !== null),
    }))
    return { total: found.total, hits: browsing ? hits.filter((hit) => hit.runsOnServers) : hits }
  }

  /** A project's versions this server could run, newest first, for choosing one. */
  async versions(actor: Actor, serverId: string, projectId: string): Promise<CatalogVersion[]> {
    const { desired } = await this.#load(actor, serverId)
    const target = { gameVersion: desired.gameVersion, loaders: catalogLoadersFor(runningLoader(desired)) }
    const versions = await this.#reading(() => this.#catalog.versions(projectId, target))
    return versions.filter((v) => v.state !== 'absent' && serverEnvironment(v.environment) !== null)
  }

  /**
   * The same resolution, for a world that does not exist yet: a template, a copied setup or a
   * modpack, resolved against a version and a server type before anything is created.
   */
  async resolveNew(
    target: { gameVersion: string; loader: Loader },
    wanted: ReadonlyArray<{ projectId: string; versionId?: string | undefined; dir?: string | undefined }>,
  ): Promise<ModPlan> {
    const empty: ServerRevision = {
      id: '',
      serverId: '',
      number: 0,
      gameVersion: target.gameVersion,
      loader: target.loader,
      loaderVersion: null,
      settings: defaultSettings({ name: 'new', gameMode: 'survival', maxPlayers: 5 }),
      mods: [],
      modpack: null,
      files: [],
      acknowledgedRevoked: [],
      reason: 'created',
      basedOnRevisionId: null,
      createdBy: '',
    }
    return this.#plan(empty, target.gameVersion, target.loader, { add: [...wanted] })
  }

  async plan(actor: Actor, serverId: string, change: ModChange): Promise<ModPlan> {
    const { desired } = await this.#load(actor, serverId)
    // Refused here too, not only when applied: a plan the change would refuse is a promise broken.
    playsNoPack(desired)
    const loader = runningLoader(desired)
    const plan = await this.#plan(desired, change.moveTo ?? desired.gameVersion, loader, change)
    if (plan.kind !== 'conflicts') return plan
    const fits = await this.#fitsNewer(desired, loader, change)
    return fits === null ? plan : { ...plan, movesTo: { gameVersion: fits } }
  }

  /**
   * The release a mod is really asking for. A mod without a build for the release a world runs
   * usually has one for a newer release, and the smallest move forward that works is the kindest
   * thing to offer: Blockly finds it here and says so, rather than leaving "no version for
   * 26.2" as the end of the road. Moving a world forward is one-way, so it is only ever offered.
   */
  async #fitsNewer(desired: ServerRevision, loader: Loader, change: ModChange): Promise<string | null> {
    if ((change.add ?? []).length === 0 && change.upgrade === undefined) return null
    const newer = offeredVersions()
      .map((offered) => offered.id)
      .filter((id) => compareVersions(id, desired.gameVersion) > 0 && supports(id, loader))
      .sort(compareVersions)
      .slice(0, NEWER_RELEASES_TRIED)
    for (const gameVersion of newer) {
      const plan = await this.#plan(desired, gameVersion, loader, change)
      if (plan.kind === 'ok') return gameVersion
    }
    return null
  }

  /**
   * The change as planned. `expected` is the jars the owner was shown; if the catalog moved in
   * between, the owner looks again rather than getting something they didn't see.
   */
  async apply(
    actor: Actor,
    serverId: string,
    change: ModChange,
    expected: readonly string[],
    requestId: string,
    options: ChangeOptions = {},
  ): Promise<MinecraftServer> {
    const { desired } = await this.#load(actor, serverId)
    const loader = runningLoader(desired)
    const gameVersion = change.moveTo ?? desired.gameVersion
    const plan = await this.#decided(desired, gameVersion, loader, change, expected)
    const resolved = { basedOn: plan.basedOn, mods: plan.mods }
    // A vanilla world keeps its version and its world; the server type comes with the mod, in
    // the same change, so nobody is asked to choose a loader to install something. A release the
    // owner accepted moves in the same change too, for the same reason.
    if (loader !== desired.loader || gameVersion !== desired.gameVersion)
      return this.#revisions.changeVersion(
        actor,
        serverId,
        {
          gameVersion,
          loader,
          loaderVersion: await this.#pin(loader, gameVersion, runsOnPaper(desired)),
          resolved,
        },
        requestId,
        options,
      )
    return this.#revisions.changeMods(actor, serverId, resolved, requestId, options)
  }

  /** What moving to another game version or server type does to the mods: every one resolved again. */
  async planVersion(
    actor: Actor,
    serverId: string,
    target: { gameVersion: string; loader: Loader },
  ): Promise<ModPlan> {
    const { desired } = await this.#load(actor, serverId)
    playsNoPack(desired)
    return this.#plan(desired, target.gameVersion, target.loader, {})
  }

  async changeVersion(
    actor: Actor,
    serverId: string,
    target: { gameVersion: string; loader: Loader; onPaper?: boolean | undefined },
    expected: readonly string[],
    requestId: string,
    options: ChangeOptions = {},
  ): Promise<MinecraftServer> {
    const { desired } = await this.#load(actor, serverId)
    const { gameVersion, loader } = target
    if (!supports(gameVersion, loader))
      throw new AppError('invalid_choice', `Cubepals does not offer ${loader} on ${gameVersion}.`)
    const plan = await this.#decided(desired, gameVersion, loader, {}, expected)
    const onPaper = target.onPaper ?? runsOnPaper(desired)
    const loaderVersion = await this.#pin(loader, gameVersion, onPaper)
    return this.#revisions.changeVersion(
      actor,
      serverId,
      { gameVersion, loader, loaderVersion, resolved: { basedOn: plan.basedOn, mods: plan.mods } },
      requestId,
      options,
    )
  }

  /**
   * The build a change pins: its server type's, or, for plain Minecraft, Paper's where it runs on
   * Paper and Paper has a build for the release (`runsOnPaper`).
   */
  #pin(loader: Loader, gameVersion: string, onPaper: boolean): Promise<string | null> {
    if (loader !== 'vanilla') return loaderPin(this.#builds, loader, gameVersion)
    return onPaper ? paperPin(this.#builds, gameVersion, 'refuse') : Promise.resolve(null)
  }

  async #decided(
    desired: ServerRevision,
    gameVersion: string,
    loader: Loader,
    change: ModChange,
    expected: readonly string[],
  ): Promise<Extract<ModPlan, { kind: 'ok' }>> {
    const plan = await this.#plan(desired, gameVersion, loader, change)
    if (plan.kind === 'conflicts')
      throw new AppError(
        'mods_conflict',
        `These mods can't run together: ${plan.conflicts.map((c) => c.mod).join(', ')}.`,
      )
    const jars = plan.mods.map((m) => m.artifact.sha512).sort()
    if (jars.join() !== [...expected].sort().join())
      throw new AppError(
        'changed_meanwhile',
        'The mod catalog changed since you looked. Look at the mods again, then try once more.',
      )
    return plan
  }

  async #plan(
    desired: ServerRevision,
    gameVersion: string,
    loader: Loader,
    change: ModChange,
  ): Promise<ModPlan> {
    const removed = new Set(change.remove ?? [])
    const uploaded = await this.#published(desired, change.addUploads ?? [])
    const current = await this.#withUploads(
      desired,
      desired.mods.filter((m) => !removed.has(identity(m))),
      uploaded.own,
    )
    // One entry per project; one the owner adds again with a version takes that version.
    const wanted = new Map<string, { projectId: string; versionId?: string | undefined }>()
    for (const mod of current)
      if (mod.origin === 'user' && 'projectId' in mod.source)
        wanted.set(mod.source.projectId, { projectId: mod.source.projectId })
    for (const added of [...uploaded.catalog, ...(change.add ?? [])])
      wanted.set(added.projectId, { projectId: added.projectId, versionId: added.versionId })
    const request: ResolveRequest = {
      catalog: this.#catalog.id,
      target: { gameVersion, loaders: catalogLoadersFor(loader) },
      wanted: [...wanted.values()],
      current,
      upgrade: change.upgrade === 'all' ? 'all' : new Set(change.upgrade ?? []),
      environment: serverEnvironment,
    }
    const { result, data } = await this.#resolve(request)
    if (result.kind === 'conflicts') return result
    if (result.kind !== 'resolved') throw new Error('Resolving mods did not settle')

    const mods = keepingFolders(result.mods, current, change.add)
    // A revocation seen here is one the hourly refresh would otherwise only find unchanged.
    const moved = await this.#sync.recordObserved(observedStates(result.mods, data))
    if (moved.length > 0) await this.#catalogMoved(moved)
    const before = new Map(desired.mods.map((m) => [identity(m), m]))
    const after = new Map(mods.map((m) => [identity(m), m]))
    const revoked = (await revokedIn(this.#db, mods)).filter(
      (m) => !desired.acknowledgedRevoked.includes(m.artifact.sha512),
    )
    return {
      kind: 'ok',
      basedOn: desired.id,
      mods,
      added: mods.filter((m) => !before.has(identity(m))),
      removed: desired.mods.filter((m) => !after.has(identity(m))),
      updated: mods.flatMap((to) => {
        const from = before.get(identity(to))
        return from !== undefined && from.artifact.sha512 !== to.artifact.sha512 ? [{ from, to }] : []
      }),
      revoked,
    }
  }

  /**
   * Uploads being added, split by whether the catalog publishes their bytes. One it does is added
   * as that exact catalog version, so it brings what it depends on and is held to where it runs,
   * as if the owner had found it by name; only the rest are pinned as the owner's own jars.
   */
  async #published(
    desired: ServerRevision,
    added: readonly string[],
  ): Promise<{ own: string[]; catalog: Array<{ projectId: string; versionId: string }> }> {
    if (added.length === 0) return { own: [], catalog: [] }
    const records = await loadModUploads(this.#db, added)
    const server = await findServer(this.#db, desired.serverId)
    if (records.length !== new Set(added).size || records.some((u) => u.ownerId !== server?.ownerId))
      throw new NotFound('Upload')
    const found = await this.#reading(() => this.#catalog.filesByHash(records.map((u) => u.sha512)))
    const own: string[] = []
    const catalog: Array<{ projectId: string; versionId: string }> = []
    for (const upload of records) {
      const match = found.get(upload.sha512)
      if (match === undefined) own.push(upload.id)
      else catalog.push({ projectId: match.version.projectId, versionId: match.version.versionId })
    }
    return { own, catalog }
  }

  /**
   * The mods a plan starts from, with the uploads it adds pinned, and every upload's game
   * versions read again from what its jar declares: Blockly may offer versions it didn't when
   * the upload was pinned.
   */
  async #withUploads(
    desired: ServerRevision,
    current: readonly PinnedMod[],
    added: readonly string[],
  ): Promise<PinnedMod[]> {
    const pinned = current
      .filter((m) => !('versionId' in m.source))
      .map((m) => (m.source as { uploadId: string }).uploadId)
    const wanted = added.filter((id) => !pinned.includes(id))
    const records = new Map((await loadModUploads(this.#db, [...pinned, ...wanted])).map((u) => [u.id, u]))
    // Only an upload being added needs an owner to check it against, and a server that does not
    // exist yet — a template or a modpack being resolved — has none to look up.
    const server = wanted.length === 0 ? null : await findServer(this.#db, desired.serverId)
    for (const id of wanted) {
      const upload = records.get(id)
      if (upload === undefined || upload.ownerId !== server?.ownerId) throw new NotFound('Upload')
    }
    const refreshed = current.map((mod) => {
      const upload = 'uploadId' in mod.source ? records.get(mod.source.uploadId) : undefined
      return upload === undefined
        ? mod
        : { ...mod, gameVersions: gameVersionsOf(upload.metadata.gameVersions) }
    })
    return [...refreshed, ...wanted.map((id) => pinUpload(records.get(id) as ModUploadRecord))]
  }

  /** Resolution asks, the catalog answers, until the set is decided (§15.5's IO step). */
  async #resolve(request: ResolveRequest) {
    const data = {
      projects: new Map<string, CatalogProject | null>(),
      fitting: new Map<string, readonly CatalogVersion[]>(),
      versions: new Map<string, CatalogVersion | null>(),
    }
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = resolve(request, data)
      if (result.kind !== 'need') return { result, data }
      await this.#reading(async () => {
        await Promise.all(
          result.projects.map(async (projectId) => {
            const [project, fitting] = await Promise.all([
              this.#catalog.project(projectId),
              this.#catalog.versions(projectId, request.target),
            ])
            data.projects.set(projectId, project)
            data.fitting.set(projectId, fitting)
          }),
        )
        if (result.versions.length > 0) {
          const found = await this.#catalog.versionsByIds(result.versions)
          for (const versionId of result.versions) data.versions.set(versionId, found.get(versionId) ?? null)
        }
      })
    }
    return { result: resolve(request, data), data }
  }

  /** The catalog being down stops authoring with nothing written (§15.3). */
  async #reading<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch (error) {
      if (error instanceof CatalogUnavailable)
        throw new AppError(
          'catalog_unavailable',
          "Modrinth isn't answering right now. Nothing changed; try again in a minute.",
        )
      throw error
    }
  }

  async #load(actor: Actor, serverId: string): Promise<{ server: MinecraftServer; desired: ServerRevision }> {
    const server = authorize(actor, await findServer(this.#db, serverId))
    return { server, desired: await loadRevision(this.#db, server.desiredRevisionId) }
  }
}

/** An upload, pinned as it is: its own bytes from the store, and the facts its jar declares. */
function pinUpload(upload: ModUploadRecord): PinnedMod {
  const { metadata } = upload
  return {
    source: { catalog: 'upload', uploadId: upload.id },
    name: metadata.name,
    versionLabel: metadata.version || upload.fileName,
    artifact: {
      ref: { kind: 'stored', key: upload.key },
      sha512: upload.sha512,
      sizeBytes: upload.sizeBytes,
      fileName: upload.fileName,
    },
    environment: metadata.environment === 'server' ? 'server' : 'both',
    loaders: metadata.loaders,
    gameVersions: gameVersionsOf(metadata.gameVersions),
    origin: 'user',
    requiredBy: [],
  }
}

/**
 * The releases Blockly offers that a declared range allows. Empty means "any", so a range that
 * allows none of them lists what it names instead, which no server offers.
 */
function gameVersionsOf(range: VersionRange): string[] {
  if (range.length === 0) return []
  const offered = offeredVersions()
    .map((v) => v.id)
    .filter((id) => fits(range, id))
  if (offered.length > 0) return offered
  const named = range.flat().filter((b) => b.op !== '<' && b.op !== '>')
  return [...new Set((named.length > 0 ? named : range.flat()).map((b) => b.version))]
}

/** The bytes at a URL, refusing more than the upload said it would be. */
async function readAll(url: string, sizeBytes: number): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Reading the upload back answered ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== sizeBytes)
    throw new AppError('invalid_upload', 'The file didn’t arrive whole. Upload it again.')
  return bytes
}

/** A mod's identity across revisions: its project, or its upload. */
export const identity = (mod: PinnedMod): string =>
  'projectId' in mod.source ? mod.source.projectId : `upload:${mod.source.uploadId}`

/** The states resolution saw for what it pinned: the cache must hold them before the revision exists. */
function observedStates(mods: readonly PinnedMod[], data: CatalogData) {
  const projects = new Map<string, ProjectState>()
  const versions = new Map<string, { projectId: string; state: VersionState }>()
  for (const mod of mods) {
    if (!('versionId' in mod.source)) continue
    const { projectId, versionId } = mod.source
    const project = data.projects.get(projectId)
    if (project) projects.set(projectId, project.state)
    const version =
      data.versions.get(versionId) ?? data.fitting.get(projectId)?.find((v) => v.versionId === versionId)
    if (version) versions.set(versionId, { projectId, state: version.state })
  }
  return { projects, versions }
}

/**
 * The server type a change resolves against: the server's own, or, for a vanilla world, the one
 * Blockly moves it to so it can run mods (§ compatibility). A vanilla world with no loader
 * offered for its release stays vanilla, and nothing resolves.
 */
function runningLoader(desired: ServerRevision): Loader {
  if (desired.loader !== 'vanilla') return desired.loader
  return loaderForMods(desired.gameVersion) ?? 'vanilla'
}

/**
 * A plugin placed in a folder of its own stays there through every change, as its template put
 * it: each resolved mod takes the folder its project had, or the one it is being added with.
 */
function keepingFolders(
  resolved: readonly PinnedMod[],
  current: readonly PinnedMod[],
  added: ModChange['add'],
): PinnedMod[] {
  const dirs = new Map<string, string>()
  for (const mod of current)
    if (mod.dir !== undefined && 'projectId' in mod.source) dirs.set(mod.source.projectId, mod.dir)
  for (const add of added ?? []) if (add.dir !== undefined) dirs.set(add.projectId, add.dir)
  return resolved.map((mod) => {
    const dir = 'projectId' in mod.source ? dirs.get(mod.source.projectId) : undefined
    return dir === undefined ? mod : { ...mod, dir }
  })
}

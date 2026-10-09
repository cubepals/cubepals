import type { Db } from '@blockly/db'
import { copying } from '../../domain/listing/trust.ts'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import type { Loader } from '../../domain/revision/revision.ts'
import { type MemoryTier, memoryMb, PARTY, type PartySize } from '../../domain/server/size.ts'
import { type ServerSetup, setupOf } from '../../domain/setup/setup.ts'
import { loaderOfPack, serverEnvironment } from '../../minecraft/mods.ts'
import { packNotes, packTierFor } from '../../minecraft/pack-build.ts'
import { packEnvironment, packTier, suggestedForServers } from '../../minecraft/packs.ts'
import { compareVersions, offeredVersions, packRuns, supports } from '../../minecraft/versions.ts'
import type { Actor } from '../actor.ts'
import type { PackCuration } from '../curation/service.ts'
import { AppError, NotFound } from '../errors.ts'
import { trustOf } from '../listings/judge.ts'
import { loadListing } from '../listings/persistence.ts'
import type { ModService } from '../mods/service.ts'
import type { PackContents } from '../packs/contents.ts'
import type { PackService } from '../packs/service.ts'
import type { ModCatalog } from '../ports/catalog.ts'
import { type FileFormats, UnreadableFile } from '../ports/formats.ts'
import { findByInvite, findLiveBySlug, loadRevision, loadRuntime, loadWorld } from '../servers/persistence.ts'
import { loadPackChecks, savePackCheck } from './persistence.ts'
import { templateOf } from './templates.ts'

/** Where a new server's setup comes from. */
export type SetupSource =
  /** Without a version, the newest release everything in the template runs on. */
  | { kind: 'template'; key: string; gameVersion?: string }
  /** Another server anyone may see, or one an invite link points at. */
  | { kind: 'server'; slug?: string; invite?: string }
  /** A modpack from the catalog; without a version, the newest one Blockly can run. */
  | { kind: 'modpack'; projectId: string; versionId?: string }
  /**
   * A pack Blockly offers by name (docs/modpack-templates.md); without a version, the release it
   * offers now.
   */
  | { kind: 'curated'; key: string; version?: string }
  /** A pack its owner uploaded, once Blockly has read it (packs/). */
  | { kind: 'import'; importId: string }

/** A setup, resolved against the catalog: what a new server would actually run. */
export interface ResolvedSetup {
  setup: ServerSetup
  gameVersion: string
  loader: Loader
  mods: PinnedMod[]
  /** The pack the new server plays, where it plays one; then `mods` is empty. */
  modpack: PinnedModpack | null
  /** The smallest size this should run on, before the party size is considered. */
  tier: MemoryTier
  /** What the source is called, for the create flow to say what is being copied. */
  from: string
  /** The server being copied, by its own name and picture; null for a template or a pack. */
  copying: Copying | null
  /** What Blockly did with a pack that its owner should know, in one sentence each. */
  notes: string[]
}

/** A server whose setup is being copied, as the create flow pictures it. */
export interface Copying {
  name: string
  /** Its own picture, by key; null where its owner hasn't picked one. */
  icon: string | null
}

/**
 * Turning intent into a server that boots (§15.6). A setup says what to play; this decides the
 * release it runs on, the mods that come with it, the build of the loader and the size it needs,
 * so that nobody making a server is asked about any of them.
 */
/** How long a pack's verdict stands before a list looks again: packs publish new versions. */
const PACK_CHECK_FRESH_MS = 24 * 60 * 60 * 1000
/** The default list's packs checked ahead of anybody picking one: more than its first page. */
const BROWSED_CHECKED = 40

export class SetupService {
  readonly #db: Db
  readonly #mods: ModService
  readonly #catalog: ModCatalog
  readonly #formats: FileFormats
  /** Packs being checked now, so a list asking again doesn't check one twice at once. */
  readonly #checking = new Set<string>()
  readonly #providers: readonly string[]
  readonly #contents: PackContents
  readonly #packs: PackService
  readonly #curation: () => PackCuration

  constructor(deps: {
    db: Db
    mods: ModService
    catalog: ModCatalog
    formats: FileFormats
    /** The runtimes this deployment runs: a binding to another is foreign. */
    providers: readonly string[]
    contents: PackContents
    packs: PackService
    /** Curated packs pin through setups, so this reaches them through a getter. */
    curation: () => PackCuration
  }) {
    this.#db = deps.db
    this.#mods = deps.mods
    this.#catalog = deps.catalog
    this.#formats = deps.formats
    this.#providers = deps.providers
    this.#contents = deps.contents
    this.#packs = deps.packs
    this.#curation = deps.curation
  }

  /** The setup behind a source, with nothing resolved yet. */
  async setupFrom(
    source: SetupSource,
    viewer: Actor | null,
  ): Promise<{ setup: ServerSetup; from: string; copying: Copying | null }> {
    if (source.kind === 'template') {
      const template = templateOf(source.key)
      if (template === null) throw new NotFound('Template')
      const asked = source.gameVersion
      if (asked !== undefined && !offeredVersions().some((offered) => offered.id === asked))
        throw new AppError('invalid_choice', `Cubepals doesn’t offer Minecraft ${asked}.`)
      return {
        setup: {
          ...template.setup,
          gameVersion: asked ?? '',
          loaderVersion: null,
          party: '5',
          modpack: null,
        },
        from: template.title,
        copying: null,
      }
    }
    if (source.kind === 'modpack') {
      const pack = await this.#judged(source.projectId, source.versionId)
      return {
        setup: {
          gameVersion: pack.gameVersion,
          loader: pack.loader,
          loaderVersion: null,
          mods: [],
          modpack: {
            catalog: pack.pinned.catalog,
            projectId: pack.pinned.projectId,
            versionId: pack.pinned.versionId,
          },
          settings: {},
          world: { levelType: 'minecraft:normal', hardcore: false },
          party: '5',
        },
        from: pack.pinned.name,
        copying: null,
      }
    }
    if (source.kind === 'curated') {
      const { pack, release } = await this.#curation().releaseFor(source.key, source.version)
      return {
        setup: {
          gameVersion: release.facts.gameVersion,
          loader: release.facts.loader as Loader,
          loaderVersion: release.facts.loaderVersion,
          mods: [],
          modpack: {
            catalog: release.pack.catalog,
            projectId: release.pack.projectId,
            versionId: release.pack.versionId,
            curated: { key: release.key, version: release.version },
          },
          settings: {},
          world: { levelType: 'minecraft:normal', hardcore: false },
          party: '5',
        },
        from: pack.name,
        copying: null,
      }
    }
    if (source.kind === 'import') {
      if (viewer?.kind !== 'user') throw new NotFound('Upload')
      const pinned = await this.#packs.pinnedFrom(viewer, source.importId)
      if (pinned.kind === 'catalog')
        return this.setupFrom(
          { kind: 'modpack', projectId: pinned.projectId, versionId: pinned.versionId },
          viewer,
        )
      return {
        setup: {
          gameVersion: pinned.summary.gameVersion,
          loader: pinned.summary.loader as Loader,
          loaderVersion: pinned.summary.loaderVersion,
          mods: [],
          modpack: { catalog: 'upload', projectId: source.importId, versionId: pinned.pinned.versionId },
          settings: {},
          world: { levelType: 'minecraft:normal', hardcore: false },
          party: '5',
        },
        from: pinned.pinned.name,
        copying: null,
      }
    }
    const server =
      source.invite !== undefined
        ? await findByInvite(this.#db, source.invite)
        : await findLiveBySlug(this.#db, source.slug ?? '')
    if (server === null) throw new NotFound('Server')
    // Only what a server actually booted can be copied: that is the configuration known to work.
    const { applied } = await loadRuntime(this.#db, server.id, this.#providers)
    if (applied === null)
      throw new AppError('invalid_choice', 'That server hasn’t started yet, so there is nothing to copy.')
    const revision = await loadRevision(this.#db, applied.revisionId)
    const world = await loadWorld(this.#db, applied.worldId)
    const owner = viewer?.kind === 'user' && viewer.userId === server.ownerId
    const allowed = owner || source.invite !== undefined || (await this.#shared(server.id))
    if (!allowed) throw new NotFound('Server')
    if (revision.mods.some((mod) => !('projectId' in mod.source)))
      throw new AppError(
        'invalid_choice',
        'This server runs a mod its owner uploaded, which is theirs alone, so Cubepals can’t make another like it.',
      )
    if (revision.modpack?.catalog === 'upload')
      throw new AppError(
        'invalid_choice',
        'This server plays a pack its owner uploaded, which is theirs alone, so Cubepals can’t make another like it.',
      )
    // Someone else gets a copy only of a setup Blockly vouches for, and only while its owner offers
    // copies: the same rule the page asks before it shows the button.
    if (!owner) {
      const offered = (await loadListing(this.#db, server.id))?.copyable ?? true
      const rule = copying(await trustOf(this.#db, revision), offered)
      if (!rule.allowed)
        throw new AppError(
          'invalid_choice',
          rule.locked
            ? 'This server runs mods Cubepals hasn’t checked, so it can’t make another like it.'
            : 'Its owner doesn’t offer copies of this server.',
        )
    }
    return {
      setup: setupOf(revision, world, partyOf(applied.memoryTier)),
      from: server.name,
      copying: { name: server.name, icon: server.icon },
    }
  }

  /**
   * The setup as a server: the newest release everything in it runs on, the mods it comes with,
   * and the size those need. A template names no version, and a copy keeps the one it runs.
   */
  async resolve(source: SetupSource, viewer: Actor | null): Promise<ResolvedSetup> {
    const { setup, from, copying } = await this.setupFrom(source, viewer)
    if (source.kind === 'import' && setup.modpack?.catalog === 'upload' && viewer?.kind === 'user') {
      const pinned = await this.#packs.pinnedFrom(viewer, source.importId)
      if (pinned.kind === 'built')
        return {
          setup,
          gameVersion: setup.gameVersion,
          loader: setup.loader,
          mods: [],
          modpack: pinned.pinned,
          tier: pinned.summary.tier as MemoryTier,
          from: pinned.pinned.name,
          copying: null,
          notes: pinned.summary.notes,
        }
    }
    // A curated release resolves to what checking it found, with nothing asked of the catalog.
    if (setup.modpack?.curated !== undefined) {
      const { pack, release } = await this.#curation().releaseFor(
        setup.modpack.curated.key,
        setup.modpack.curated.version,
      )
      const loader = release.facts.loader as Loader
      return {
        setup: {
          ...setup,
          gameVersion: release.facts.gameVersion,
          loader,
          loaderVersion: release.facts.loaderVersion,
        },
        gameVersion: release.facts.gameVersion,
        loader,
        mods: [],
        modpack: release.pack,
        tier: release.facts.tier as MemoryTier,
        from: pack.name,
        copying,
        notes: release.facts.notes,
      }
    }
    if (setup.modpack !== null) {
      const pack = await this.#pack(setup.modpack.projectId, setup.modpack.versionId)
      return {
        setup: {
          ...setup,
          gameVersion: pack.gameVersion,
          loader: pack.loader,
          loaderVersion: pack.loaderVersion,
        },
        gameVersion: pack.gameVersion,
        loader: pack.loader,
        mods: [],
        modpack: pack.pinned,
        tier: pack.tier,
        from: pack.pinned.name,
        copying,
        notes: pack.notes,
      }
    }
    const versions =
      setup.gameVersion === ''
        ? offeredVersions()
            .map((offered) => offered.id)
            .filter((id) => supports(id, setup.loader))
            .sort((a, b) => compareVersions(b, a))
        : [setup.gameVersion]

    let conflicts: string[] = []
    for (const gameVersion of versions) {
      const wanted = setup.mods.map((mod) => ({
        projectId: mod.projectId,
        // A copy's mods keep the builds it ran; a template's name none, and resolve for the version.
        ...(setup.gameVersion === '' || mod.versionId === undefined ? {} : { versionId: mod.versionId }),
      }))
      const plan = await this.#mods.resolveNew({ gameVersion, loader: setup.loader }, wanted)
      if (plan.kind === 'ok')
        return {
          setup: { ...setup, gameVersion },
          gameVersion,
          loader: setup.loader,
          mods: plan.mods,
          modpack: null,
          tier: tierFor(plan.mods),
          from,
          copying,
          notes: [],
        }
      conflicts = plan.conflicts.map((conflict) => conflict.mod)
    }
    throw new AppError(
      'mods_conflict',
      conflicts.length > 0
        ? `Cubepals can't run ${conflicts.join(', ')} on any Minecraft it offers right now.`
        : 'Cubepals has no Minecraft version that runs this right now.',
    )
  }

  /**
   * Packs checked the way picking them would be, one at a time and never twice at once, so the
   * lists know which can't run before anybody picks one (§15.6). One the catalog can't answer for
   * now waits for the next look.
   */
  async checkPacks(projectIds: readonly string[]): Promise<void> {
    for (const projectId of projectIds) {
      if (this.#checking.has(projectId)) continue
      this.#checking.add(projectId)
      try {
        await this.#judged(projectId, undefined)
      } catch {
        // A refusal is kept by #judged; anything else is the catalog, asked again next time.
      } finally {
        this.#checking.delete(projectId)
      }
    }
  }

  /** Which of these packs have no verdict from the last day. */
  async unchecked(projectIds: readonly string[], now = new Date()): Promise<string[]> {
    const checked = await loadPackChecks(this.#db, this.#catalog.id, projectIds)
    return projectIds.filter((id) => {
      const check = checked.get(id)
      return check === undefined || now.getTime() - check.checkedAt.getTime() > PACK_CHECK_FRESH_MS
    })
  }

  /**
   * `pack-checks`: the default list's packs, checked before anybody picks one, so a pack Blockly
   * can't run as a server never stands in it. Returns how many were checked.
   */
  async checkBrowsed(now = new Date()): Promise<number> {
    const { hits } = await this.#catalog.searchModpacks({ text: '', offset: 0, limit: BROWSED_CHECKED })
    const due = await this.unchecked(
      hits.filter((hit) => suggestedForServers(hit.environments)).map((hit) => hit.projectId),
      now,
    )
    await this.checkPacks(due)
    return due.length
  }

  /**
   * `#pack`, keeping what it found about a pack's default version, the one a pick without a
   * version gets: that it runs, or the words it was refused with, for the lists to use.
   */
  async #judged(projectId: string, versionId: string | undefined) {
    try {
      const pack = await this.#pack(projectId, versionId)
      if (versionId === undefined)
        await savePackCheck(this.#db, this.#catalog.id, projectId, null, new Date())
      return pack
    } catch (error) {
      if (versionId === undefined && error instanceof AppError && error.code === 'invalid_choice')
        await savePackCheck(this.#db, this.#catalog.id, projectId, error.message, new Date())
      throw error
    }
  }

  /**
   * A modpack pinned to one version: the one asked for, or the newest a server can run. What it
   * runs on comes from the pack's own index, never from a question and never from the catalog's
   * tags alone: the release and the loader build it names, on any release a pack can run on
   * (`packRuns`). The jars of it that only run in players' games are left off the server by name.
   */
  async #pack(
    projectId: string,
    versionId: string | undefined,
  ): Promise<{
    pinned: PinnedModpack
    gameVersion: string
    loader: Loader
    loaderVersion: string | null
    tier: MemoryTier
    notes: string[]
  }> {
    const project = await this.#catalog.project(projectId)
    if (project === null) throw new NotFound('Modpack')
    // A pack meant for a player's own game cannot be what a server runs, however popular it is.
    const environment = packEnvironment(project.environments)
    if (environment === 'client')
      throw new AppError(
        'invalid_choice',
        `${project.name} is made for a player's own game, not for a server.`,
      )
    const versions =
      versionId === undefined
        ? await this.#catalog.modpackVersions(project.projectId)
        : [await this.#catalog.version(versionId)].filter((version) => version !== null)
    // What is judged is the version a server would install, never the pack's name: one that
    // publishes both kinds has its versions for players' games passed over here.
    const forServers = versions.filter((version) => serverEnvironment(version.environment) !== null)
    if (versionId !== undefined && versions.length > 0 && forServers.length === 0)
      throw new AppError(
        'invalid_choice',
        `That version of ${project.name} is made for a player's own game, not for a server.`,
      )
    for (const version of forServers) {
      const tagged = loaderOfPack(version.loaders)
      if (tagged === null) continue
      if (!version.gameVersions.some((id) => packRuns(id, tagged))) continue
      const read = await this.#contents.ofCatalog(version.file).catch((error: unknown) => {
        // A pack that can't be read by ranges runs as its tags say; its first start tells the rest.
        if (error instanceof UnreadableFile) return null
        throw error
      })
      if (read?.kind === 'refused') {
        if (versionId !== undefined)
          throw new AppError('invalid_choice', `${project.name}: ${lower(read.message)}`)
        continue
      }
      if (read !== null && read.handDownloads.length > 0)
        throw new AppError(
          'invalid_choice',
          `${project.name} leaves ${read.handDownloads.length} of its mods for each player to download by hand, which a server can’t do, so it can’t run as one.`,
        )
      const contents = read?.contents ?? null
      const loader: Loader = contents?.loader ?? tagged
      const gameVersion =
        contents?.gameVersion ??
        version.gameVersions.filter((id) => packRuns(id, loader)).sort((a, b) => compareVersions(b, a))[0]
      if (gameVersion === undefined || !packRuns(gameVersion, loader)) continue
      const leaveOut = (contents?.leftOut ?? []).filter((l) => l.why === 'players').map((l) => l.path)
      const jarBytes = (contents?.jars ?? []).reduce((total, jar) => total + jar.sizeBytes, 0)
      return {
        gameVersion,
        loader,
        loaderVersion: contents?.loaderVersion ?? null,
        tier:
          contents === null
            ? packTier(project.categories)
            : packTierFor({
                memoryMb: contents.memoryMb,
                categories: project.categories,
                mods: contents.jars.length,
                jarBytes,
              }),
        notes: packNotes({ leftOutForPlayers: leaveOut, worlds: 0, memoryMb: contents?.memoryMb ?? null }),
        pinned: {
          catalog: this.#catalog.id,
          projectId: project.projectId,
          versionId: version.versionId,
          name: project.name,
          versionLabel: version.versionLabel,
          artifact: {
            ref: { kind: 'remote', url: version.file.url },
            sha512: version.file.sha512,
            sizeBytes: version.file.sizeBytes,
            fileName: version.file.fileName,
          },
          page: this.#catalog.projectPage(project.projectId),
          environment,
          icon: project.iconUrl,
          ...(leaveOut.length > 0 ? { leaveOut } : {}),
        },
      }
    }
    throw new AppError(
      'invalid_choice',
      versionId === undefined
        ? `${project.name} has no version that runs on the Minecraft releases Cubepals offers.`
        : `That version of ${project.name} doesn’t run on any Minecraft release Cubepals offers.`,
    )
  }

  /** One exact version of a catalog pack, pinned as a server would play it: for a pack change. */
  pinnedPack(projectId: string, versionId: string) {
    return this.#pack(projectId, versionId)
  }

  /** Whether a server is shared widely enough that its setup may be copied by a stranger. */
  async #shared(serverId: string): Promise<boolean> {
    const listing = await loadListing(this.#db, serverId)
    return listing !== null && listing.visibility === 'published' && listing.moderation === 'clear'
  }
}

/**
 * The size a set of mods needs before anyone is counted, following the capacity research: a
 * light pack wants 4 GB, anything heavier the large size, and a handful of server-side mods costs
 * no more than vanilla. Jar bytes are the signal, not the number of mods.
 */
export function tierFor(mods: readonly PinnedMod[]): MemoryTier {
  if (mods.length === 0) return '3g'
  const bytes = mods.reduce((total, mod) => total + mod.artifact.sizeBytes, 0)
  const megabytes = bytes / (1024 * 1024)
  // A handful of mods costs no more than vanilla, whatever they weigh: one plugin shipped as a
  // 23 MB shaded jar is not a modpack, and a smoke run caught this sizing it as a 4 GB server —
  // which the free plan doesn't sell, so copying an ordinary server was refused outright. What
  // makes a server heavy is many mods doing many things at once, which is the next line.
  if (mods.length <= 10 && megabytes <= 100) return '3g'
  if (megabytes < 200 && mods.length < 60) return '4g'
  // Past a light pack a server wants four cores, which come with 8 GB: 6 GB is no longer sold.
  return '8g'
}

/** The size a server ends up on: the bigger of what the party needs and what it runs needs. */
export function sizeOf(party: PartySize, needs: MemoryTier): MemoryTier {
  const forParty = PARTY[party].tier
  return memoryMb(needs) > memoryMb(forParty) ? needs : forParty
}

/** A sentence carried after a pack's name: "Cobblemon: this pack has no index…" */
const lower = (sentence: string) => sentence.charAt(0).toLowerCase() + sentence.slice(1)

const partyOf = (tier: string): PartySize =>
  (Object.keys(PARTY) as PartySize[]).find((size) => PARTY[size].tier === tier) ?? '5'

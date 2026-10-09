/**
 * What a server someone asks for will be: its release, server type, size, settings, first
 * revision and first world, decided before anything is written.
 *
 * It writes nothing and runs no transaction. Recording the server, claiming its address, placing
 * it on a runtime and queueing its provisioning is `MinecraftServerService.createMinecraftServer`
 * (`service.ts`), which runs this first.
 */
import type { Db } from '@blockly/db'
import { entitlementsFor } from '../../domain/account/entitlements.ts'
import type { CarriedFile } from '../../domain/revision/carried.ts'
import { defaultSettings, type Loader, type RevisionDraft } from '../../domain/revision/revision.ts'
import { type MemoryTier, PARTY, type PartySize } from '../../domain/server/size.ts'
import { nextLevelName, type World } from '../../domain/world/world.ts'
import { DEFAULT_GAME_VERSION, DEFAULT_LOADER, packRuns, supports } from '../../minecraft/versions.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import { AppError } from '../errors.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import type { RegionCatalog } from '../ports/platform.ts'
import { fittedDefaults, requireWithinPlan } from '../revisions/caps.ts'
import { loaderPin, paperPin } from '../revisions/pins.ts'
import type { ResolvedSetup, SetupSource } from '../setups/service.ts'
import { sizeOf } from '../setups/service.ts'
import type { NewServer } from './persistence.ts'

export interface CreateServerRequest {
  idempotencyKey: string
  name: string
  slug?: string | undefined
  /** What to play: a template, or another server's setup. Without one, plain survival. */
  from?: SetupSource | undefined
  playStyle?: 'survival' | 'creative' | undefined
  partySize: PartySize
  gameVersion?: string | undefined
  loader?: Loader | undefined
  regionKey?: string | undefined
  seed?: string | undefined
  hardcore?: boolean | undefined
  /** Made for a while: Blockly deletes it after a day unless its owner keeps it. */
  temporary?: boolean | undefined
  /** The owner's server whose first build failed, which this one takes the place of. */
  replaces?: string | undefined
}

/** Everything about a new server that is decided before it is written. */
export interface NewServerDraft {
  regionKey: string
  memoryTier: MemoryTier
  createdFrom: NewServer['createdFrom']
  revision: RevisionDraft
  world: Omit<World, 'id' | 'serverId'>
  /** The owner's plan, and the disk it starts a server on, for placing it. */
  plan: string
  storageGb: number
  /** What the audit row adds about where it came from: a template, or a curated pack's release. */
  origin: Record<string, unknown>
}

export async function draftNewServer(
  sources: {
    db: Db
    regions: RegionCatalog
    builds: LoaderBuilds
    resolve: (from: SetupSource, actor: UserActor) => Promise<ResolvedSetup>
  },
  actor: UserActor,
  request: CreateServerRequest,
): Promise<NewServerDraft> {
  // What to play decides the release, the server type, the mods and the size; nobody making a
  // server is asked about any of them.
  const chosen = request.from === undefined ? null : await sources.resolve(request.from, actor)
  const gameVersion = chosen?.gameVersion ?? request.gameVersion ?? DEFAULT_GAME_VERSION
  const loader = chosen?.loader ?? request.loader ?? DEFAULT_LOADER
  // A pack brings its own release and loader, which may be one Blockly doesn't offer a new world.
  const runs = chosen?.modpack ? packRuns(gameVersion, loader) : supports(gameVersion, loader)
  if (!runs) throw new AppError('invalid_choice', `Cubepals does not offer ${loader} on ${gameVersion} yet.`)
  const regionKey = request.regionKey ?? sources.regions.defaultKey
  if (sources.regions.label(regionKey) === null)
    throw new AppError('invalid_choice', 'That location is not available.')
  const party = PARTY[request.partySize]
  const memoryTier = chosen === null ? party.tier : sizeOf(request.partySize, chosen.tier)
  const standing = await loadStanding(sources.db, actor.userId)
  const plan = entitlementsFor(standing.plan, standing.limitOverrides)
  const settings = fittedDefaults(plan, {
    ...defaultSettings({
      name: request.name,
      gameMode: request.playStyle ?? 'survival',
      maxPlayers: party.maxPlayers,
    }),
    ...chosen?.setup.settings,
  })
  requireWithinPlan(plan, { loader, settings, mods: chosen?.mods ?? [], modpack: chosen?.modpack ?? null })

  const revision: RevisionDraft = {
    gameVersion,
    loader,
    loaderVersion: await firstPin(sources.builds, request, chosen, loader, gameVersion),
    settings,
    mods: chosen?.mods ?? [],
    modpack: chosen?.modpack ?? null,
    files: carriedBy(chosen),
    acknowledgedRevoked: [],
    reason: 'created',
    basedOnRevisionId: null,
  }

  const createdFrom =
    request.from === undefined
      ? 'direct'
      : request.from.kind === 'server'
        ? request.from.invite === undefined
          ? 'copy'
          : 'invite'
        : request.from.kind === 'import'
          ? 'upload'
          : request.from.kind
  return {
    regionKey,
    memoryTier,
    createdFrom,
    revision,
    world: {
      levelName: nextLevelName([]),
      name: 'World',
      // A seed is never copied from another world: it would give away where everything is.
      seed: request.seed || null,
      levelType: chosen?.setup.world.levelType ?? 'minecraft:normal',
      hardcore: chosen?.setup.world.hardcore ?? request.hardcore ?? false,
      generatedOnVersion: gameVersion,
    },
    plan: standing.plan,
    storageGb: plan.storage.startGb,
    origin: {
      ...(request.from?.kind === 'template' ? { template: request.from.key } : {}),
      ...(chosen?.modpack?.curated === undefined
        ? {}
        : { curated: chosen.modpack.curated.key, release: chosen.modpack.curated.version }),
    },
  }
}

/**
 * The build a new server's first revision pins: the one the setup it copies pinned, else its server
 * type's current one. Plain Minecraft made from nothing or from a template runs on Paper where
 * Paper has a build for its release (`runsOnPaper`), which its owner can turn off in its settings.
 */
async function firstPin(
  builds: LoaderBuilds,
  request: CreateServerRequest,
  chosen: ResolvedSetup | null,
  loader: Loader,
  gameVersion: string,
): Promise<string | null> {
  if (chosen !== null && chosen.setup.loaderVersion !== null) return chosen.setup.loaderVersion
  const fresh = request.from === undefined || request.from.kind === 'template'
  if (loader === 'vanilla' && fresh && (chosen?.mods ?? []).length === 0)
    return paperPin(builds, gameVersion, 'plain')
  return loaderPin(builds, loader, gameVersion)
}

/** The files a new server's setup carries; one made without a setup carries none. */
const carriedBy = (chosen: ResolvedSetup | null): CarriedFile[] => [...(chosen?.setup.files ?? [])]

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a server someone asks for will be: its release, server type, size, settings, first
 * revision and first world, decided before anything is written.
 *
 * It writes nothing and runs no transaction. Recording the server, claiming its address, placing
 * it on a runtime and queueing its provisioning is `MinecraftServerService.createMinecraftServer`
 * (`service.ts`), which runs this first.
 */
import { NAME_MAX_LENGTH } from '@blockly/contracts'
import type { Db, Tx } from '@blockly/db'
import type { SeededAccess } from '../../domain/access/access.ts'
import { diskForBroughtWorld, type Entitlements, entitlementsFor } from '../../domain/account/entitlements.ts'
import { isDatapack } from '../../domain/mods/artifact.ts'
import type { CarriedFile } from '../../domain/revision/carried.ts'
import {
  bedrockOf,
  defaultSettings,
  isPlain,
  type Loader,
  type RevisionDraft,
  runsOnPaper,
  type ServerSettings,
} from '../../domain/revision/revision.ts'
import { type MemoryTier, PARTY, type PartySize } from '../../domain/server/size.ts'
import { nextLevelName, type World } from '../../domain/world/world.ts'
import { joinRange } from '../../minecraft/clients.ts'
import {
  DEFAULT_GAME_VERSION,
  DEFAULT_LOADER,
  isRelease,
  notOffered,
  packRuns,
  supports,
} from '../../minecraft/versions.ts'
import { loadStanding } from '../accounts/persistence.ts'
import type { UserActor } from '../actor.ts'
import type { BroughtWorld } from '../backups/new-world-imports.ts'
import { AppError } from '../errors.ts'
import type { LoaderBuilds } from '../ports/loaders.ts'
import type { RegionCatalog } from '../ports/platform.ts'
import { fittedDefaults, requireWithinPlan } from '../revisions/caps.ts'
import { loaderPin, paperPin } from '../revisions/pins.ts'
import type { ResolvedSetup, SetupSource } from '../setups/service.ts'
import { sizeOf } from '../setups/service.ts'
import { createRuntimeBinding, growStorage, type NewServer } from './persistence.ts'

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
  /** That disk where it is past the plan's first, as a world its owner brought needs; else null. */
  grownGb: number | null
  /** Who it lets in from the server a world its owner brought came from, as they chose; else null. */
  access: SeededAccess | null
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
  if (!runs) throw new AppError('invalid_choice', notOffered(loader, gameVersion))
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
  revision.settings = withChoices(revision, request.from)

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
    ...firstWorld(request, chosen, gameVersion, plan),
    plan: standing.plan,
    origin: {
      ...(request.from?.kind === 'template' ? { template: request.from.key } : {}),
      ...(chosen?.modpack?.curated === undefined
        ? {}
        : { curated: chosen.modpack.curated.key, release: chosen.modpack.curated.version }),
    },
  }
}

/** A new server's binding to the runtime it was placed on, and the disk its first world needs. */
export async function bindNewRuntime(
  tx: Tx,
  serverId: string,
  provider: string,
  grownGb: number | null,
): Promise<void> {
  await createRuntimeBinding(tx, serverId, provider)
  if (grownGb !== null) await growStorage(tx, serverId, grownGb)
}

/** A new server's first world, and the disk it starts with: one with room for a world brought. */
function firstWorld(
  request: CreateServerRequest,
  chosen: ResolvedSetup | null,
  gameVersion: string,
  plan: Entitlements,
): Pick<NewServerDraft, 'world' | 'storageGb' | 'grownGb' | 'access'> {
  const brought = chosen?.brought
  if (brought === undefined)
    return {
      world: newWorld(request, chosen, gameVersion),
      storageGb: plan.storage.startGb,
      grownGb: null,
      access: null,
    }
  const disk = diskForBroughtWorld(plan, brought.facts.sizeBytes, brought.startsOn.sizeBytes)
  return {
    world: broughtWorld(brought, gameVersion),
    storageGb: disk,
    grownGb: disk > plan.storage.startGb ? disk : null,
    // Who its owner let in of the players of the server it came from; nobody they didn't choose.
    access: brought.access,
  }
}

/** A new server's first world, as Minecraft generates it. */
function newWorld(
  request: CreateServerRequest,
  chosen: ResolvedSetup | null,
  gameVersion: string,
): NewServerDraft['world'] {
  return {
    levelName: nextLevelName([]),
    name: 'World',
    // A seed is never copied from another world: it would give away where everything is.
    seed: request.seed || null,
    levelType: chosen?.setup.world.levelType ?? 'minecraft:normal',
    hardcore: chosen?.setup.world.hardcore ?? request.hardcore ?? false,
    generatedOnVersion: gameVersion,
  }
}

/**
 * A new server's first world, where its owner brought one: their own, by its own name and seed,
 * which its first start unpacks (`minecraft/starter.ts`). One a snapshot last saved counts as made
 * on the release the server runs, which is the one it is opened on.
 */
function broughtWorld(brought: BroughtWorld, gameVersion: string): NewServerDraft['world'] {
  const { facts } = brought
  return {
    levelName: nextLevelName([]),
    name: (facts.name ?? 'World').slice(0, NAME_MAX_LENGTH),
    seed: facts.seed,
    levelType: facts.levelType,
    hardcore: facts.hardcore,
    generatedOnVersion: isRelease(facts.gameVersion) ? facts.gameVersion : gameVersion,
    startsOn: brought.startsOn,
  }
}

/**
 * The build a new server's first revision pins: the one the setup it copies pinned, else its server
 * type's current one. Plain Minecraft made from nothing or from a template runs on Paper where
 * Paper has a build for its release (`runsOnPaper`), datapacks and all, which its owner can turn off
 * in its settings.
 */
async function firstPin(
  builds: LoaderBuilds,
  request: CreateServerRequest,
  chosen: ResolvedSetup | null,
  loader: Loader,
  gameVersion: string,
): Promise<string | null> {
  if (chosen !== null && chosen.setup.loaderVersion !== null) return chosen.setup.loaderVersion
  const fresh =
    request.from === undefined || request.from.kind === 'template' || request.from.kind === 'world'
  if (loader === 'vanilla' && fresh && (chosen?.mods ?? []).every((mod) => isDatapack(mod)))
    return paperPin(builds, gameVersion, 'plain')
  return loaderPin(builds, loader, gameVersion)
}

/**
 * Which players' games join a new server, and whether Bedrock friends do where the deployment lets
 * them in (`offered`), as the create page says it before the server is made.
 */
export function newJoins(
  from: SetupSource,
  chosen: ResolvedSetup,
  offered: boolean,
): { joins: { oldest: string; newer: boolean }; bedrock: boolean } {
  const onPaper = startsOnPaper(from, chosen)
  // The build is read as the server is made; that there will be one is all the range asks.
  const loaderVersion = onPaper ? (chosen.setup.loaderVersion ?? 'paper') : null
  const settings = withChoices({ ...chosen, loaderVersion, settings: chosen.setup.settings }, from)
  const joins = joinRange({ ...chosen, loaderVersion, settings })
  const paper = chosen.modpack === null && (chosen.loader === 'paper' || onPaper)
  return { joins, bedrock: offered && paper && bedrockOf({ loader: chosen.loader, settings }) }
}

/**
 * Whether a new server runs plain Minecraft on Paper, as `firstPin` decides it, before any build list
 * is read: one made from nothing or a template where Cubepals offers Paper for its release, and a
 * copy where the server it copies ran on Paper.
 */
function startsOnPaper(
  from: SetupSource | undefined,
  chosen: Pick<ResolvedSetup, 'loader' | 'gameVersion' | 'mods' | 'modpack'> & {
    setup: Pick<ResolvedSetup['setup'], 'loaderVersion'>
  },
): boolean {
  if (!isPlain(chosen)) return false
  if (chosen.setup.loaderVersion !== null) return true
  return (
    (from === undefined || from.kind === 'template' || from.kind === 'world') &&
    supports(chosen.gameVersion, 'paper')
  )
}

/**
 * What a new plain server on Paper lets in, as any Paper server does: Bedrock friends, and players
 * on other versions, which most releases need for Bedrock players to reach them. A plain server
 * that never chose either has them off (`otherVersionsOf`), so a new one says so; one copied keeps
 * the choices its source made.
 */
const PLAIN_ON_PAPER = {
  otherVersions: 'on',
  bedrock: true,
} as const satisfies Partial<ServerSettings>

/**
 * A new revision's settings, with the choices a plain server on Paper is made with. A copy has
 * none added: it keeps the choices its source made, and one that made none has them off.
 */
const withChoices = <S extends Partial<ServerSettings>>(
  revision: Parameters<typeof runsOnPaper>[0] & { settings: S },
  from: SetupSource | undefined,
): S =>
  runsOnPaper(revision) && from?.kind !== 'server'
    ? { ...PLAIN_ON_PAPER, ...revision.settings }
    : revision.settings

/** The files a new server's setup carries; one made without a setup carries none. */
const carriedBy = (chosen: ResolvedSetup | null): CarriedFile[] => [...(chosen?.setup.files ?? [])]

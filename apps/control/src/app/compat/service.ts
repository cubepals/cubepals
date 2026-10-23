// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Via plugins Cubepals adds to every Paper server as it starts, plain Minecraft run on Paper
 * included, so players on other Minecraft versions join it: ViaVersion and ViaBackwards unless its owner turned them off, and ViaRewind
 * too where they let in 1.8 and 1.7 (`ServerSettings.otherVersions`). They are Cubepals'
 * compatibility layer, never the owner's plugins: they are not in the server's revision, so no
 * plan, limit or price that counts plugins counts them, and the owner's plugin list never shows
 * them. The settings page says which versions join, and the switch is the way back.
 *
 * Floodgate, and the Via plugins its release needs, are placed the same way where Bedrock players
 * are let in (`ServerSettings.bedrock`), but not where the owner lets no other version in and the
 * release is not the one Geyser speaks (`minecraft/bedrock.ts`).
 *
 * Grim, which Stop cheaters runs, is pinned and placed the same way (`grimFor`), wherever the
 * server's Stop cheaters is on (`app/stop-cheaters/`), on plain Minecraft run on Paper too.
 *
 * Each release's jars are pinned once from the catalog (`refresh`, a scheduled job), so every
 * server on it starts with the same ones, and a start never waits on the catalog. A release with
 * none pinned yet starts without them. A sleeping server's wake boots once where it slept without
 * the ones it now places (`servers/specs.ts`). Which clients a server takes is
 * `minecraft/clients.ts`'s, from the ones a boot placed or the next will (`joinsNow`).
 */
import type { BedrockView } from '@blockly/contracts'
import { type AppliedConfigJson, type Db, type Queryable, schema } from '@blockly/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import {
  bedrockOf,
  isPlain,
  otherVersionsOf,
  runsOnPaper,
  type ServerRevision,
} from '../../domain/revision/revision.ts'
import { bedrockAvailable, bedrockPlugins, FLOODGATE } from '../../minecraft/bedrock.ts'
import { joinsOf } from '../../minecraft/clients.ts'
import { COMPAT, runsPlugin, VIABACKWARDS, VIAREWIND, VIAVERSION } from '../../minecraft/mods.ts'
import { GRIM, runsOwnGrim } from '../../minecraft/stop-cheaters.ts'
import { offeredVersions, supports } from '../../minecraft/versions.ts'
import type { ModService } from '../mods/service.ts'
import type { GeyserMc } from '../ports/geysermc.ts'

const { compatPlugins, minecraftServers: servers, serverRevisions: revisions } = schema

/** Where a Paper server's plugins go, under its directory: Cubepals' step places these there itself. */
const PLUGINS_DIR = 'plugins'

/** What each release is pinned with, the most first: a release ViaRewind doesn't run on still gets the other two. */
const TRIES: readonly (readonly string[])[] = [
  [VIAVERSION, VIABACKWARDS, VIAREWIND],
  [VIAVERSION, VIABACKWARDS],
  [VIAVERSION],
]

export class CompatPlugins {
  readonly #db: Db
  readonly #mods: Pick<ModService, 'resolveNew'>
  readonly #geyser: GeyserMc | null

  /**
   * Which players' games a server takes and whether Bedrock players join it (`joinsNow`). A
   * deployment without the Bedrock key lets none in, and no page says anything of them.
   */
  joins(q: Queryable, revision: Parameters<typeof joinsNow>[1], run: Parameters<typeof joinsNow>[2]) {
    return joinsNow(q, revision, { ...run, offered: this.#geyser !== null })
  }

  /** Whether the deployment lets Bedrock players in at all: without the Bedrock key, none. */
  get offered(): boolean {
    return this.#geyser !== null
  }

  constructor(deps: { db: Db; mods: Pick<ModService, 'resolveNew'>; geyser: GeyserMc | null }) {
    this.#db = deps.db
    this.#mods = deps.mods
    this.#geyser = deps.geyser
  }

  /**
   * `compat-pins`: the Via plugins pinned again for each release Cubepals offers Paper on and each
   * one a Paper server runs, Grim for each where Grim publishes a build, and Floodgate, whose one
   * jar runs on them all. A release the catalog can't answer for keeps what it had. How many
   * releases were pinned.
   */
  async refresh(): Promise<number> {
    let pinned = 0
    const floodgate = await this.#floodgate()
    for (const gameVersion of await this.#releases()) {
      if (floodgate !== null) await this.#pin(gameVersion, [floodgate], [FLOODGATE])
      const grim = await this.#mods
        .resolveNew({ gameVersion, loader: 'paper' }, [{ projectId: GRIM }])
        .catch(() => null)
      if (grim?.kind === 'ok') await this.#pin(gameVersion, grim.mods, [GRIM])
      let via = false
      for (const wanted of TRIES) {
        const plan = await this.#mods
          .resolveNew(
            { gameVersion, loader: 'paper' },
            wanted.map((projectId) => ({ projectId })),
          )
          .catch(() => null)
        if (plan?.kind !== 'ok') continue
        await this.#pin(gameVersion, plan.mods, TRIES[0] ?? [])
        via = true
        break
      }
      if (via || grim?.kind === 'ok' || floodgate !== null) pinned++
    }
    return pinned
  }

  /** Floodgate's newest Paper jar as a pinned plugin; null where GeyserMC can't be asked or lists none. */
  async #floodgate(): Promise<PinnedMod | null> {
    const jar = await this.#geyser?.latestFloodgate().catch(() => null)
    if (jar === null || jar === undefined) return null
    return {
      source: { catalog: 'geysermc', projectId: FLOODGATE, versionId: `${jar.version}-${jar.build}` },
      name: 'Floodgate',
      versionLabel: `${jar.version} build ${jar.build}`,
      artifact: {
        ref: { kind: 'remote', url: jar.url },
        sha512: jar.sha512,
        sizeBytes: jar.sizeBytes,
        fileName: jar.fileName,
      },
      environment: 'server',
      loaders: ['paper'],
      gameVersions: [],
      origin: 'dependency',
      requiredBy: [],
    }
  }

  /**
   * The releases to pin for: every one Paper is offered on, and every one a live server runs on
   * Paper or plain Minecraft, which runs on Paper.
   */
  async #releases(): Promise<string[]> {
    const running = await this.#db
      .selectDistinct({ gameVersion: revisions.gameVersion })
      .from(revisions)
      .innerJoin(servers, eq(servers.desiredRevisionId, revisions.id))
      .where(and(inArray(revisions.loader, ['paper', 'vanilla']), isNull(servers.deletedAt)))
    const offered = offeredVersions()
      .map((version) => version.id)
      .filter((id) => supports(id, 'paper'))
    return [...new Set([...offered, ...running.map((row) => row.gameVersion)])]
  }

  /** `projects`' pins for a release, in place of the ones it had; any other project's stay. */
  async #pin(gameVersion: string, mods: readonly PinnedMod[], projects: readonly string[]): Promise<void> {
    const kept = mods.filter((mod) => 'projectId' in mod.source && projects.includes(mod.source.projectId))
    await this.#db.transaction(async (tx) => {
      await tx
        .delete(compatPlugins)
        .where(
          and(eq(compatPlugins.gameVersion, gameVersion), inArray(compatPlugins.projectId, [...projects])),
        )
      for (const mod of kept)
        await tx.insert(compatPlugins).values({
          gameVersion,
          projectId: (mod.source as { projectId: string }).projectId,
          pinned: mod,
          pinnedAt: new Date(),
        })
    })
  }
}

/** What a revision is read for, to know whether it runs on Paper (`runsPaper`). */
type OnPaper = Pick<ServerRevision, 'loader' | 'loaderVersion' | 'modpack'> & {
  mods: ReadonlyArray<Pick<PinnedMod, 'loaders'>>
}

/**
 * A server that runs Paper's plugins, and so Cubepals' own: Paper, or plain Minecraft run on Paper,
 * playing no pack.
 */
const runsPaper = (revision: OnPaper): boolean =>
  revision.modpack === null && (revision.loader === 'paper' || runsOnPaper(revision))

/** Whether a Paper server's choice and its other versions' leave Bedrock players able to join. */
const bedrockWanted = (revision: Pick<ServerRevision, 'gameVersion' | 'loader' | 'settings'>): boolean =>
  bedrockOf(revision) && bedrockAvailable(revision.gameVersion, otherVersionsOf(revision) === 'off')

/**
 * The Via plugins a revision starts with, placed in the plugins folder by Cubepals' own step: on a
 * Paper server or plain Minecraft run on Paper, those its choice asks for, as pinned for its
 * release, but any the owner runs already as their own plugin. None on any other server type, or
 * one playing a pack.
 */
export async function compatFor(
  q: Queryable,
  revision: Pick<ServerRevision, 'gameVersion' | 'loader' | 'loaderVersion' | 'modpack' | 'settings'> & {
    mods: ReadonlyArray<Pick<PinnedMod, 'source' | 'name' | 'loaders'>>
  },
): Promise<PinnedMod[]> {
  if (!runsPaper(revision)) return []
  // The Via plugins its choice asks for, and Floodgate with the ones Bedrock players need.
  const choice = COMPAT[otherVersionsOf(revision)]
  const bedrock = bedrockWanted(revision) ? bedrockPlugins(revision.gameVersion) : []
  const wanted = [...new Set([...choice, ...bedrock])].filter((id) => !runsPlugin(revision.mods, id))
  if (wanted.length === 0) return []
  const rows = await q
    .select({ projectId: compatPlugins.projectId, pinned: compatPlugins.pinned })
    .from(compatPlugins)
    .where(and(eq(compatPlugins.gameVersion, revision.gameVersion), inArray(compatPlugins.projectId, wanted)))
  // What Bedrock players need comes only with Floodgate: a release with none pinned has no Bedrock.
  const bedrockPinned = rows.some((row) => row.projectId === FLOODGATE)
  const pins = wanted
    .filter((id) => choice.includes(id) || (bedrockPinned && bedrock.includes(id)))
    .flatMap((id) => rows.filter((row) => row.projectId === id).map((row) => row.pinned as PinnedMod))
  // An addon goes only beside ViaVersion, which it can't load without; Floodgate needs no other plugin.
  const viaAddons = new Set([VIABACKWARDS, VIAREWIND])
  const hasVia = runsPlugin([...revision.mods, ...pins], VIAVERSION)
  const placed = pins.filter(
    (mod) => hasVia || !('projectId' in mod.source && viaAddons.has(mod.source.projectId)),
  )
  return placed.map((mod) => ({ ...mod, dir: PLUGINS_DIR }))
}

/** What `grimFor` reads of a revision. */
export const GRIM_FIELDS = [
  'gameVersion',
  'loader',
  'loaderVersion',
  'mods',
  'modpack',
] as const satisfies ReadonlyArray<keyof ServerRevision>
export type GrimFacts = Pick<ServerRevision, (typeof GRIM_FIELDS)[number]>

/**
 * Grim as a start places it where Stop cheaters is on: on Paper, or plain Minecraft run on Paper,
 * playing no pack, as pinned for its release. None where the owner runs Grim as their own plugin:
 * theirs runs, and its punishments file is still written. `release` where Grim has no build pinned
 * for the release yet, and `modded` on any other server type.
 */
export async function grimFor(
  q: Queryable,
  revision: GrimFacts,
): Promise<{ kind: 'placed'; jar: PinnedMod | null } | { kind: 'release' } | { kind: 'modded' }> {
  if (!runsGrim(revision)) return { kind: 'modded' }
  if (runsOwnGrim(revision.mods)) return { kind: 'placed', jar: null }
  const [row] = await q
    .select({ pinned: compatPlugins.pinned })
    .from(compatPlugins)
    .where(and(eq(compatPlugins.gameVersion, revision.gameVersion), eq(compatPlugins.projectId, GRIM)))
  if (row === undefined) return { kind: 'release' }
  return { kind: 'placed', jar: { ...(row.pinned as PinnedMod), dir: PLUGINS_DIR } }
}

/** A server Grim can run on: Paper, or plain Minecraft run on Paper, with no pack. */
const runsGrim = runsPaper

/** Which Via plugins `placed` holds, by Modrinth project id, as a boot's record and the edge name them. */
export const projectsOf = (placed: readonly PinnedMod[]): string[] =>
  placed.flatMap((mod) => ('projectId' in mod.source ? [mod.source.projectId] : []))

/**
 * Which players' games a server on `revision` takes, as its page says it and the edge lets them in:
 * running on a boot of it (`applied`), with the Via plugins that boot placed, none for a boot from
 * before one said; otherwise with those its next boot places.
 *
 * Whether Bedrock players join it: on a server that runs Paper, as its choice says; plain Minecraft
 * on Mojang's own server can't take them, and letting them in moves it onto Paper (`moves`), where
 * Paper has a build for its release.
 */
export async function joinsNow(
  q: Queryable,
  revision: Pick<
    ServerRevision,
    'id' | 'gameVersion' | 'loader' | 'loaderVersion' | 'modpack' | 'settings'
  > & {
    mods: ReadonlyArray<Pick<PinnedMod, 'source' | 'name' | 'loaders'>>
  },
  run: {
    running: boolean
    applied: Pick<AppliedConfigJson, 'revisionId' | 'compat'> | null
    /** Whether the deployment lets Bedrock players in; without it a page says nothing of them. */
    offered?: boolean
  },
): Promise<{ joins: ReturnType<typeof joinsOf>; bedrock: BedrockView | null | false }> {
  const booted = run.running && run.applied?.revisionId === revision.id
  const placed = booted ? (run.applied?.compat ?? []) : projectsOf(await compatFor(q, revision))
  // Whether it lets Bedrock players in, as its choice says, and whether its other versions stop them.
  const paper = runsPaper(revision)
  const moves = !paper && isPlain(revision) && supports(revision.gameVersion, 'paper')
  const on = paper && bedrockOf(revision)
  const bedrock = paper || moves ? { on, needsOtherVersions: on && !bedrockWanted(revision), moves } : null
  return { joins: joinsOf(revision, placed), bedrock: run.offered === true ? bedrock : false }
}

/**
 * Whether Bedrock players join a server on `revision` now, as a page anyone can open says it: on
 * a deployment that lets them in, a Paper server whose choice and other versions let them in.
 */
export const takesBedrock = (
  revision: OnPaper & Pick<ServerRevision, 'gameVersion' | 'settings'>,
  offered: boolean,
): boolean => offered && runsPaper(revision) && bedrockWanted(revision)

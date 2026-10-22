// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Via plugins Cubepals adds to every Paper server as it starts, so players on other Minecraft
 * versions join it: ViaVersion and ViaBackwards unless its owner turned them off, and ViaRewind
 * too where they let in 1.8 and 1.7 (`ServerSettings.otherVersions`). They are Cubepals'
 * compatibility layer, never the owner's plugins: they are not in the server's revision, so no
 * plan, limit or price that counts plugins counts them, and the owner's plugin list never shows
 * them. The settings page says which versions join, and the switch is the way back.
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
import { type AppliedConfigJson, type Db, type Queryable, schema } from '@blockly/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { otherVersionsOf, runsOnPaper, type ServerRevision } from '../../domain/revision/revision.ts'
import { joinsOf } from '../../minecraft/clients.ts'
import { COMPAT, runsPlugin, VIABACKWARDS, VIAREWIND, VIAVERSION } from '../../minecraft/mods.ts'
import { GRIM, runsOwnGrim } from '../../minecraft/stop-cheaters.ts'
import { offeredVersions, supports } from '../../minecraft/versions.ts'
import type { ModService } from '../mods/service.ts'

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

  constructor(deps: { db: Db; mods: Pick<ModService, 'resolveNew'> }) {
    this.#db = deps.db
    this.#mods = deps.mods
  }

  /**
   * `compat-pins`: the Via plugins pinned again for each release Cubepals offers Paper on and each
   * one a Paper server runs, and Grim for each where Grim publishes a build. A release the catalog
   * can't answer for keeps what it had. How many releases were pinned.
   */
  async refresh(): Promise<number> {
    let pinned = 0
    for (const gameVersion of await this.#releases()) {
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
      if (via || grim?.kind === 'ok') pinned++
    }
    return pinned
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

/**
 * The Via plugins a revision starts with, placed in the plugins folder by Cubepals' own step: on a
 * Paper server, those its choice asks for, as pinned for its release, but any the owner runs
 * already as their own plugin. None on any other server type, or one playing a pack.
 */
export async function compatFor(
  q: Queryable,
  revision: Pick<ServerRevision, 'gameVersion' | 'loader' | 'modpack' | 'settings'> & {
    mods: ReadonlyArray<Pick<PinnedMod, 'source' | 'name'>>
  },
): Promise<PinnedMod[]> {
  if (revision.loader !== 'paper' || revision.modpack !== null) return []
  const wanted = COMPAT[otherVersionsOf(revision.settings)].filter((id) => !runsPlugin(revision.mods, id))
  if (wanted.length === 0) return []
  const rows = await q
    .select({ projectId: compatPlugins.projectId, pinned: compatPlugins.pinned })
    .from(compatPlugins)
    .where(and(eq(compatPlugins.gameVersion, revision.gameVersion), inArray(compatPlugins.projectId, wanted)))
  // An addon goes only beside ViaVersion, which it can't load without.
  const pins = wanted.flatMap((id) =>
    rows.filter((row) => row.projectId === id).map((row) => row.pinned as PinnedMod),
  )
  if (!runsPlugin([...revision.mods, ...pins], VIAVERSION)) return []
  return pins.map((mod) => ({ ...mod, dir: PLUGINS_DIR }))
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
const runsGrim = (revision: Pick<ServerRevision, 'loader' | 'loaderVersion' | 'mods' | 'modpack'>): boolean =>
  revision.modpack === null && (revision.loader === 'paper' || runsOnPaper(revision))

/** Which Via plugins `placed` holds, by Modrinth project id, as a boot's record and the edge name them. */
export const projectsOf = (placed: readonly PinnedMod[]): string[] =>
  placed.flatMap((mod) => ('projectId' in mod.source ? [mod.source.projectId] : []))

/**
 * Which players' games a server on `revision` takes, as its page says it and the edge lets them in:
 * running on a boot of it (`applied`), with the Via plugins that boot placed, none for a boot from
 * before one said; otherwise with those its next boot places.
 */
export async function joinsNow(
  q: Queryable,
  revision: Pick<ServerRevision, 'id' | 'gameVersion' | 'loader' | 'modpack' | 'settings'> & {
    mods: ReadonlyArray<Pick<PinnedMod, 'source' | 'name'>>
  },
  run: { running: boolean; applied: Pick<AppliedConfigJson, 'revisionId' | 'compat'> | null },
): Promise<{ joins: ReturnType<typeof joinsOf> }> {
  const booted = run.running && run.applied?.revisionId === revision.id
  const placed = booted ? (run.applied?.compat ?? []) : projectsOf(await compatFor(q, revision))
  return { joins: joinsOf(revision, placed) }
}

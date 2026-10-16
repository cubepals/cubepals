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
 * Each release's jars are pinned once from the catalog (`refresh`, a scheduled job), so every
 * server on it starts with the same ones, and a start never waits on the catalog. A release with
 * none pinned yet starts without them. Not for which clients a server takes, which
 * `minecraft/clients.ts` works out from the same choice.
 */
import { type Db, type Queryable, schema } from '@blockly/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { PinnedMod } from '../../domain/mods/artifact.ts'
import { otherVersionsOf, type ServerRevision } from '../../domain/revision/revision.ts'
import { COMPAT, runsPlugin, VIABACKWARDS, VIAREWIND, VIAVERSION } from '../../minecraft/mods.ts'
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
   * one a Paper server runs. A release the catalog can't answer for keeps what it had. How many
   * releases were pinned.
   */
  async refresh(): Promise<number> {
    let pinned = 0
    for (const gameVersion of await this.#releases()) {
      for (const wanted of TRIES) {
        const plan = await this.#mods
          .resolveNew(
            { gameVersion, loader: 'paper' },
            wanted.map((projectId) => ({ projectId })),
          )
          .catch(() => null)
        if (plan?.kind !== 'ok') continue
        await this.#pin(gameVersion, plan.mods)
        pinned++
        break
      }
    }
    return pinned
  }

  /** The releases to pin for: every one Paper is offered on, and every one a live Paper server runs. */
  async #releases(): Promise<string[]> {
    const running = await this.#db
      .selectDistinct({ gameVersion: revisions.gameVersion })
      .from(revisions)
      .innerJoin(servers, eq(servers.desiredRevisionId, revisions.id))
      .where(and(eq(revisions.loader, 'paper'), isNull(servers.deletedAt)))
    const offered = offeredVersions()
      .map((version) => version.id)
      .filter((id) => supports(id, 'paper'))
    return [...new Set([...offered, ...running.map((row) => row.gameVersion)])]
  }

  async #pin(gameVersion: string, mods: readonly PinnedMod[]): Promise<void> {
    const via = mods.filter((mod) => 'projectId' in mod.source && TRIES[0]?.includes(mod.source.projectId))
    await this.#db.transaction(async (tx) => {
      await tx.delete(compatPlugins).where(eq(compatPlugins.gameVersion, gameVersion))
      for (const mod of via)
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
  revision: Pick<ServerRevision, 'gameVersion' | 'loader' | 'mods' | 'modpack' | 'settings'>,
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

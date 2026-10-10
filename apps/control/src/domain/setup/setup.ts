// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { PinnedMod } from '../mods/artifact.ts'
import type { ReleaseRef } from '../mods/curation.ts'
import type { CarriedFile } from '../revision/carried.ts'
import type { Loader, ServerRevision, ServerSettings } from '../revision/revision.ts'
import type { PartySize } from '../server/size.ts'
import type { World } from '../world/world.ts'

/**
 * A setup is the portable half of a server: what makes the experience, with nothing of the place
 * it came from. Templates, "create a server like this" and modpacks are all setups, and a setup
 * turned into a first revision is how every server begins.
 *
 * What a setup carries:
 * - the Minecraft version, the server type and, where one is being copied exactly, its build
 * - the mods their owner chose, by catalog project and version; what those mods need is resolved
 *   again rather than copied, since dependencies change
 * - or, instead of those, the modpack it plays, which brings its own mods and configuration
 * - the files Cubepals wrote for what it plays, such as a plugin's settings, carried as they are
 * - the settings that decide how it plays: difficulty, game mode, PvP, spawn protection, and how
 *   far the world is seen and simulated
 * - how the world is made: its type, and whether it is hardcore
 * - the party size Blockly suggests, which the plan may still cut down
 *
 * What a setup never carries, because it belongs to the server it came from:
 * - the world itself, and its seed, which would give away where everything in it is
 * - players, the whitelist, operators and bans
 * - secrets, tokens and anything signed
 * - jars its owner uploaded, which are theirs and which Blockly never vouches for
 * - the name, description, icon, address and message of the day: the new server gets its own
 * - whether it checks players with Minecraft's account servers: every new server does, whatever
 *   the one it came from does, since its owner has not chosen otherwise
 */
export interface ServerSetup {
  gameVersion: string
  loader: Loader
  /** The exact build to run, when copying something that already runs; null pins the newest. */
  loaderVersion: string | null
  mods: SetupMod[]
  /** The modpack it plays, in place of a mod list of its own. */
  modpack: SetupModpack | null
  /** Files Cubepals wrote for it, by their path under the server's directory; absent: none. */
  files?: readonly CarriedFile[]
  settings: SetupSettings
  world: { levelType: string; hardcore: boolean }
  party: PartySize
}

/** A mod by where it lives, not by its bytes: the same setup resolves months later. */
interface SetupMod {
  catalog: string
  projectId: string
  /** The exact version, when copying something that runs; absent takes the newest that fits. */
  versionId?: string
  /** Where its jar goes, when not the loader's own folder: `plugins/BentoBox/addons`. */
  dir?: string
}

/** A modpack by where it lives; without a version, the newest one Blockly can run. */
interface SetupModpack {
  catalog: string
  projectId: string
  versionId?: string
  /**
   * The curated release it is, when it is one Blockly offers by name: a copy plays that same
   * reviewed release, fetched the way the review allows, rather than the catalog's file.
   */
  curated?: ReleaseRef
}

/** The settings that make an experience; the rest of a server's settings are its own. */
type SetupSettings = Partial<
  Pick<
    ServerSettings,
    'difficulty' | 'defaultGameMode' | 'pvp' | 'spawnProtection' | 'viewDistance' | 'simulationDistance'
  >
>

/** The setup a running server is an instance of: what someone else could make for themselves. */
export function setupOf(
  revision: Pick<
    ServerRevision,
    'gameVersion' | 'loader' | 'loaderVersion' | 'settings' | 'mods' | 'modpack' | 'files'
  >,
  world: Pick<World, 'levelType' | 'hardcore'>,
  party: PartySize,
): ServerSetup {
  return {
    gameVersion: revision.gameVersion,
    loader: revision.loader,
    loaderVersion: revision.loaderVersion,
    mods: revision.mods.filter(copyable).map((mod) => ({
      catalog: (mod.source as { catalog: string }).catalog,
      projectId: (mod.source as { projectId: string }).projectId,
      versionId: (mod.source as { versionId: string }).versionId,
      ...(mod.dir === undefined ? {} : { dir: mod.dir }),
    })),
    // A pack is copied at the exact version the server runs, so both play the same game.
    modpack:
      revision.modpack === null
        ? null
        : {
            catalog: revision.modpack.catalog,
            projectId: revision.modpack.projectId,
            versionId: revision.modpack.versionId,
            ...(revision.modpack.curated === undefined ? {} : { curated: revision.modpack.curated }),
          },
    ...(revision.files.length === 0 ? {} : { files: revision.files }),
    settings: {
      difficulty: revision.settings.difficulty,
      defaultGameMode: revision.settings.defaultGameMode,
      pvp: revision.settings.pvp,
      spawnProtection: revision.settings.spawnProtection,
      viewDistance: revision.settings.viewDistance,
      simulationDistance: revision.settings.simulationDistance,
    },
    world: { levelType: world.levelType, hardcore: world.hardcore },
    party,
  }
}

/**
 * The mods a setup may carry: ones its owner chose, from a catalog. What those need comes back
 * through resolution, and an uploaded jar is its owner's alone.
 */
const copyable = (mod: PinnedMod): boolean => mod.origin === 'user' && 'projectId' in mod.source

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an upload holds beside a world of what it was played with (docs/world-import.md § Mods),
 * from its files' names alone: the jars in the mods folder of the game's folder the world was
 * played from (`gameFolderOf`), the sources a launcher recorded for them, and the instance's own
 * files that say what it runs on. Reading those files is `pack-manifests.ts`'s, as for a pack; what
 * a mod is, the app's.
 *
 * A launcher's instance, as each launcher's own source lays it out:
 * - Prism Launcher and MultiMC: the instance's folder holds `instance.cfg` and `mmc-pack.json`
 *   (PrismLauncher/PrismLauncher, `launcher/minecraft/PackProfile.cpp`: the components it runs,
 *   Minecraft and the loader with their versions). The game's folder is `minecraft/` inside it, or
 *   `.minecraft/` where only that exists (`MinecraftInstance::gameRoot`), and holds `saves/` and
 *   `mods/` (`worldDir`, `modsRoot`). A mod installed from Prism's own browser has its source
 *   recorded in `mods/.index/<slug>.pw.toml` (`ResourceFolderModel::indexDir`, written by
 *   `launcher/modplatform/packwiz/Packwiz.cpp`, `V1::updateModIndex`) in packwiz's format.
 * - CurseForge's and the Modrinth App's instances: `saves/` and `mods/` in the instance's own folder.
 * - A world sent with a mods folder beside it, as a server's folder holds them.
 */
import { type FoundWorld, gameFolderOf, modsBeside } from './world-layout.ts'

/** A Prism or MultiMC instance's components: Minecraft, the loader and their versions (`PackProfile.cpp`). */
export const COMPONENTS_FILE = 'mmc-pack.json'
/** A Prism or MultiMC instance's settings, its name among them (`InstanceList.cpp`, `BaseInstance.cpp`). */
export const INSTANCE_SETTINGS = 'instance.cfg'
/** Where Prism records a mod's source, in the mods folder (`ResourceFolderModel::indexDir`). */
const SOURCES_FOLDER = '.index/'
/** A source's file, named for the mod's slug (`Packwiz.cpp`, `indexFileName`). */
const SOURCE_FILE = /\.pw\.toml$/

/** The small files of an instance a world's mods are read by, wherever they are in an upload. */
export const INSTANCE_FILES = /(^|\/)(mmc-pack\.json|instance\.cfg|mods\/\.index\/[^/]+\.pw\.toml)$/

/** What an upload holds beside a world of what it was played with, each by its path in the upload. */
export interface PlayedWithFiles {
  /** The jars in the mods folder it was played with. */
  jars: string[]
  /** The sources Prism recorded for those of them it installed. */
  sources: string[]
  /** The instance's components and settings, where it was played in a Prism or MultiMC instance. */
  components: string | null
  settings: string | null
}

/** The files of an upload that say what a world in it was played with. */
export function playedWithIn(paths: readonly string[], world: FoundWorld): PlayedWithFiles {
  const game = gameFolderOf(world)
  const index = `${game}mods/${SOURCES_FOLDER}`
  const present = new Set(paths)
  // The instance's own files are beside the game's folder, or in it where the two are one.
  const root = /(^|\/)\.?minecraft\/$/.test(game) ? game.replace(/\.?minecraft\/$/, '') : game
  const own = (name: string) => [`${root}${name}`, `${game}${name}`].find((path) => present.has(path)) ?? null
  return {
    jars: modsBeside(paths, world),
    sources: paths.filter(
      (path) => path.startsWith(index) && SOURCE_FILE.test(path) && !path.slice(index.length).includes('/'),
    ),
    components: own(COMPONENTS_FILE),
    settings: own(INSTANCE_SETTINGS),
  }
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A launcher's instance, for a world played with mods (`level-version.ts` says so before it is
 * sent): which folder to pick so its mods come with it, and, of an instance picked whole, the files
 * that are sent with the world chosen from it. The control plane reads what is sent the same way
 * (`minecraft/instance-layout.ts`); where each launcher keeps its instances is `saves-folders.ts`.
 *
 * How an instance is laid out, from each launcher's own source:
 * - Prism Launcher (and MultiMC, which it forked): an instance is a folder of its own under
 *   `instances/`, with `instance.cfg` and `mmc-pack.json` at its top (`PackProfile.cpp`, which
 *   writes the Minecraft, loader and build it runs as components). The game's folder is
 *   `minecraft/` below it, or `.minecraft/` where only that exists (`MinecraftInstance::gameRoot`),
 *   holding `saves/` and `mods/` (`worldDir`, `modsRoot`). A mod installed from Prism's own browser
 *   has where it came from recorded in `mods/.index/<slug>.pw.toml` (`ResourceFolderModel::indexDir`,
 *   `Packwiz::V1::updateModIndex`).
 * - CurseForge and the Modrinth App: the game's folder is the instance's own, `saves/` and `mods/`
 *   at its top.
 */
import type { Launcher, System } from './saves-folders'

/** A mod's source as Prism records it, inside an instance's mods folder (`indexDir`, `indexFileName`). */
const INDEX_FILE = /^\.index\/[^/]+\.pw\.toml$/
/** A mod in an instance's mods folder; one its launcher turned off ends `.jar.disabled`, and isn't sent. */
const JAR = /^[^/]+\.jar$/i

/** What to pick so a world's mods come with it, as the system writes paths; null for a launcher without instances. */
export interface InstancePick {
  /** The folder the launcher keeps its instances in: the instance to pick is one folder inside it. */
  instances: string
  /** From an instance's folder, its mods folder: picked beside the world where the whole instance isn't. */
  mods: string
  /** From an instance's folder, the folder its worlds are in. */
  saves: string
}

/** Where a launcher's instance keeps its worlds and mods, on `system`; null for one without instances. */
export function instancePickOn(launcher: Launcher, system: System): InstancePick | null {
  if (launcher.inInstance === null) return null
  const separator = system === 'Windows' ? '\\' : '/'
  const game = launcher.inInstance.slice(0, -1)
  return {
    instances: launcher.folders[system],
    mods: [...game, 'mods'].join(separator),
    saves: launcher.inInstance.join(separator),
  }
}

/** An instance in a picked folder: where its own files are, where the game's folder is, and its worlds. */
export interface PickedInstance {
  /** The instance's own folder, holding `mmc-pack.json`, ending in a slash; '' at the top. */
  root: string
  /** The game's folder, holding `saves/` and `mods/`, ending in a slash. */
  game: string
  /** Each world's folder, ending in a slash: those in `saves/` with a `level.dat`. */
  worlds: string[]
}

/**
 * The instance a picked folder is, from its files' paths (`Inst/minecraft/saves/Life/level.dat`),
 * or null where it isn't one: a game's folder with worlds in `saves/` and a `mods/` folder.
 */
export function instanceIn(paths: readonly string[]): PickedInstance | null {
  const worlds = new Set<string>()
  let game: string | null = null
  for (const path of paths) {
    const found = /^(.*?)saves\/[^/]+\/level\.dat$/.exec(path)
    if (found === null) continue
    const folder = found[1] ?? ''
    if (game !== null && folder !== game) continue
    game = folder
    worlds.add(path.slice(0, -'level.dat'.length))
  }
  if (game === null || !paths.some((path) => path.startsWith(`${game}mods/`))) return null
  return { root: rootOf(game), game, worlds: [...worlds].sort() }
}

/** The instance's own folder around a game's folder: the one above `minecraft/` or `.minecraft/`. */
function rootOf(game: string): string {
  const named = /(^|\/)\.?minecraft\/$/.exec(game)
  return named === null ? game : game.slice(0, named.index + (named[1] ?? '').length)
}

/**
 * Of an instance picked whole, the files sent with one of its worlds: the world's own, the jars in
 * its mods folder with the sources recorded for them, and the instance's files that say what it
 * runs on. Its other worlds, resource packs, shaders, screenshots and logs stay on the computer.
 */
export function sentWith(paths: readonly string[], instance: PickedInstance, world: string): string[] {
  const mods = `${instance.game}mods/`
  const own = new Set([`${instance.root}mmc-pack.json`, `${instance.root}instance.cfg`])
  return paths.filter((path) => {
    if (path.startsWith(world) || own.has(path)) return true
    if (!path.startsWith(mods)) return false
    const inMods = path.slice(mods.length)
    return JAR.test(inMods) || INDEX_FILE.test(inMods)
  })
}

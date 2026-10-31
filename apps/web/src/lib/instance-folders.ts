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
 * - The Minecraft Launcher has no instances: a loader installed into it plays from its game folder,
 *   whose `mods/` is beside `saves/`.
 *
 * A folder picked for a world's mods is read here too (`modsIn`): an instance, its game folder or
 * its mods folder, sent beside a world picked from somewhere else (`modsSent`). What is sent as a
 * whole is `brought-files.ts`'s.
 */
import type { Launcher, System } from './saves-folders'

/** A mod's source as Prism records it, inside an instance's mods folder (`indexDir`, `indexFileName`). */
const INDEX_FILE = /^\.index\/[^/]+\.pw\.toml$/
/** A mod in an instance's mods folder, as the control plane reads one: `.jar`, lowercase. One its launcher turned off ends `.jar.disabled`, and isn't sent. */
const JAR = /^[^/]+\.jar$/

/** What to pick so a world's mods come with it, as the system writes paths; null for a launcher without instances. */
export interface InstancePick {
  /** The folder the launcher keeps its instances in: the instance to pick is one folder inside it. */
  instances: string
  /** From an instance's folder, its mods folder: picked beside the world where the whole instance isn't. */
  mods: string
  /** From an instance's folder, the folder its worlds are in. */
  saves: string
}

/**
 * Where a launcher without instances keeps the mods a loader installed into it runs, on `system`:
 * the game folder's `mods`, beside the `saves` it keeps worlds in. Null for one with instances.
 */
export function modsFolderOn(launcher: Launcher, system: System): string | null {
  if (launcher.inInstance !== null) return null
  return launcher.folders[system].replace(/saves$/, 'mods')
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

/** Of what is in a mods folder, what is sent: its jars, and the sources Prism recorded for them. */
const isModFile = (inMods: string): boolean => JAR.test(inMods) || INDEX_FILE.test(inMods)

/** The files that say what an instance runs on, at its top (`PackProfile.cpp`, `InstanceList.cpp`). */
const OWN_FILES = ['mmc-pack.json', 'instance.cfg']

/**
 * Of an instance picked whole, the files sent with one of its worlds: the world's own, the jars in
 * its mods folder with the sources recorded for them, and the instance's files that say what it
 * runs on. Its other worlds, resource packs, shaders, screenshots and logs stay on the computer.
 */
export function sentWith(paths: readonly string[], instance: PickedInstance, world: string): string[] {
  const mods = `${instance.game}mods/`
  const own = new Set(OWN_FILES.map((name) => `${instance.root}${name}`))
  return paths.filter(
    (path) =>
      path.startsWith(world) ||
      own.has(path) ||
      (path.startsWith(mods) && isModFile(path.slice(mods.length))),
  )
}

/** A folder picked for a world's mods: where its mods folder is, and the instance's own files' folder, if any. */
export interface ModsFolder {
  /** The mods folder, ending in a slash. */
  mods: string
  /** Where `mmc-pack.json` and `instance.cfg` would be, ending in a slash; null where it is a mods folder alone. */
  root: string | null
}

/**
 * Where the mods are in a folder picked for them, from its files' paths: an instance's (its game
 * folder's `mods/`), the folder itself where it holds jars, else the shallowest `mods/` in it that
 * does. Null where it holds no mods.
 */
export function modsIn(paths: readonly string[]): ModsFolder | null {
  const instance = instanceIn(paths)
  if (instance !== null) return { mods: `${instance.game}mods/`, root: instance.root }
  let found: string | null = null
  for (const path of paths) {
    const folder = path.slice(0, path.lastIndexOf('/') + 1)
    const picked = folder.indexOf('/') === folder.length - 1
    if (!JAR.test(path.slice(folder.length)) || !(picked || /\/mods\/$/.test(folder))) continue
    if (found === null || folder.length < found.length) found = folder
  }
  if (found === null) return null
  return { mods: found, root: /(^|\/)mods\/$/.test(found) ? rootOf(found.slice(0, -'mods/'.length)) : null }
}

/**
 * The files of a mods folder sent beside a world played from `beside` (`playedFrom`), each with the
 * path it is sent at: its jars and their sources in `mods/` there, and the instance's own files
 * with them, as a server's folder holds its mods beside its world.
 */
export function modsSent(
  paths: readonly string[],
  folder: ModsFolder,
  beside: string,
): Array<{ path: string; at: string }> {
  const { root } = folder
  return paths.flatMap((path) => {
    if (root !== null && OWN_FILES.some((name) => path === `${root}${name}`))
      return [{ path, at: `${beside}${path.slice(root.length)}` }]
    const inMods = path.startsWith(folder.mods) ? path.slice(folder.mods.length) : null
    return inMods !== null && isModFile(inMods) ? [{ path, at: `${beside}mods/${inMods}` }] : []
  })
}

/**
 * The folder the world among `paths` was played from, as the control plane finds it
 * (`gameFolderOf`): the game's folder above the `saves/` it is in, else the folder it sits in, so
 * mods sent with it are where a server's folder keeps them. Its world is the shallowest `level.dat`.
 */
export function playedFrom(paths: readonly string[]): string {
  const levels = paths.filter((path) => /(^|\/)level\.dat$/.test(path))
  const level = levels.sort((a, b) => a.split('/').length - b.split('/').length)[0] ?? ''
  const world = level.slice(0, -'level.dat'.length)
  const base = world.slice(0, world.slice(0, -1).lastIndexOf('/') + 1)
  return /(^|\/)saves\/$/.test(base) ? base.slice(0, -'saves/'.length) : base
}

/** The jars beside the world among `paths`, where the control plane reads them (`modsBeside`). */
export function modsBeside(paths: readonly string[]): string[] {
  const mods = `${playedFrom(paths)}mods/`
  return paths.filter((path) => path.startsWith(mods) && JAR.test(path.slice(mods.length)))
}

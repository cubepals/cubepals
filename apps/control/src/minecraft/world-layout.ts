// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the world is in an upload, from the names of its files alone, and where each of its files
 * goes on a server (docs/world-import.md). An upload is a world folder, a saves folder of several,
 * a server's folder, a launcher's instance, or a download from another host or from Cubepals, in
 * any number of folders. On a server the world's folder is a level name Blockly makes, and the
 * Nether and End that Paper keeps beside it are renamed with it; a server's start moves them to
 * where its type reads them (`runtime-spec.ts`).
 *
 * What the files say (`level.dat`, `server.properties`) is read in `uploads.ts`; the archive is
 * the app's to open.
 */
import { normalizeUuid } from './console.ts'
import { compareVersions } from './versions.ts'

/** What an operating system or an archiver leaves beside files, never part of a world. */
const LEFT_BY_SYSTEMS = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._[^/]*$)/i

/** Whether a file is one an operating system or an archiver left, and never a world's. */
const leftBySystem = (path: string): boolean => LEFT_BY_SYSTEMS.test(path)

/** The lock a running game holds on its world; a server makes its own. */
const SESSION_LOCK = 'session.lock'

/** Where Paper keeps a world's other dimensions, beside it. */
const BESIDE = ['_nether', '_the_end'] as const

/** One world an upload holds. */
export interface FoundWorld {
  /** Its folder, ending in a slash, or '' where the upload's root is the world. */
  folder: string
  /** Its folder's own name, as its player named it; '' at the root. */
  folderName: string
  /** The Nether and End Paper kept beside it (`world_nether/`), each ending in a slash. */
  beside: string[]
  /** Its `level.dat`, or `level.dat_old` where that is all it has. */
  levelDat: string
}

/** What an upload holds. */
export type UploadHolds =
  | {
      kind: 'java'
      worlds: FoundWorld[]
      /** The `server.properties` of the server folder they are in, if they are in one. */
      properties: string | null
    }
  | { kind: 'bedrock' }
  | { kind: 'nothing' }

/** The folder a path is in, ending in a slash, or '' for one at the root. */
const folderOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1)

/** A folder's own name, without the folders around it or its slash. */
const nameOf = (folder: string): string => folder.slice(0, -1).split('/').pop() ?? ''

/**
 * The worlds in an upload, from its file names: every folder with a `level.dat` (or only a
 * `level.dat_old`), but those inside another world and those Paper keeps beside one. A Bedrock
 * save (`levelname.txt` beside a `db` folder) is told apart, so it can be refused by name.
 */
export function uploadHolds(paths: readonly string[]): UploadHolds {
  const files = paths.filter((path) => !leftBySystem(path))
  const present = new Set(files)
  // Each look below is by name in a set, never a scan of every file: an upload may hold half a
  // million of them, and a hostile one as many level.dat files.
  const withDb = foldersHolding(files, 'db/')
  // Bedrock keeps a level.dat too, beside its name and its `db` folder.
  const bedrock = (folder: string) => present.has(`${folder}levelname.txt`) && withDb.has(folder)
  const levels = new Map<string, string>()
  let bedrockSeen = false
  for (const path of files) {
    const level = /(^|\/)level\.dat(_old)?$/.exec(path)
    if (level === null) continue
    const folder = folderOf(path)
    if (bedrock(folder)) bedrockSeen = true
    else if (level[2] === undefined || !present.has(`${folder}level.dat`)) levels.set(folder, path)
  }
  // A world inside another is the other's (a copy in its folder).
  const outer = new Set([...levels.keys()].filter((folder) => !insideAny(folder, levels)))
  const homes = homesBeside(outer)
  const beside = new Map<string, string[]>()
  for (const [folder, home] of homes) beside.set(home, [...(beside.get(home) ?? []), folder])
  const worlds: FoundWorld[] = [...outer]
    .sort((a, b) => a.length - b.length)
    .filter((folder) => !homes.has(folder))
    .map((folder) => ({
      folder,
      folderName: nameOf(folder),
      beside: beside.get(folder) ?? [],
      levelDat: levels.get(folder) ?? `${folder}level.dat`,
    }))
  if (worlds.length === 0)
    return bedrockSeen || files.some((path) => /(^|\/)levelname\.txt$/.test(path) && bedrock(folderOf(path)))
      ? { kind: 'bedrock' }
      : { kind: 'nothing' }
  return { kind: 'java', worlds, properties: serverPropertiesOf(files, worlds) }
}

/** The folders Paper keeps beside a world (`world_nether/`), each with the world's own folder. */
function homesBeside(worlds: ReadonlySet<string>): Map<string, string> {
  const homes = new Map<string, string>()
  for (const folder of worlds)
    for (const suffix of BESIDE) {
      const home = `${folder.slice(0, -suffix.length - 1)}/`
      if (folder.endsWith(`${suffix}/`) && home !== '/' && worlds.has(home)) homes.set(folder, home)
    }
  return homes
}

/** Every folder, ending in a slash, that holds a folder named `inner` (`db/`) somewhere in the files. */
function foldersHolding(files: readonly string[], inner: string): Set<string> {
  const found = new Set<string>()
  for (const path of files)
    for (let at = path.indexOf(inner); at !== -1; at = path.indexOf(inner, at + 1))
      if (at === 0 || path[at - 1] === '/') found.add(path.slice(0, at))
  return found
}

/** Whether a folder is inside any of `folders`: the root, or one of the folders around it. */
function insideAny(folder: string, folders: ReadonlyMap<string, unknown>): boolean {
  if (folder === '') return false
  if (folders.has('')) return true
  for (let slash = folder.indexOf('/'); slash !== folder.length - 1; slash = folder.indexOf('/', slash + 1))
    if (folders.has(folder.slice(0, slash + 1))) return true
  return false
}

/** The `server.properties` of the folder the worlds are in, the outermost where there are several. */
function serverPropertiesOf(files: readonly string[], worlds: readonly FoundWorld[]): string | null {
  const homes = new Set(
    worlds.filter((world) => world.folder !== '').map((world) => folderOf(world.folder.slice(0, -1))),
  )
  const candidates = files
    .filter((path) => /(^|\/)server\.properties$/.test(path) && homes.has(folderOf(path)))
    .sort((a, b) => a.length - b.length)
  return candidates[0] ?? null
}

/**
 * The world to bring: the one a server folder's properties name (`levelName`, its `level-name`),
 * else the only one. Null where the player must choose.
 */
export function chosenWorld(
  holds: Extract<UploadHolds, { kind: 'java' }>,
  levelName: string | null,
): FoundWorld | null {
  if (holds.properties !== null && levelName !== null) {
    const named = holds.worlds.find(
      (world) => world.folder === `${folderOf(holds.properties as string)}${levelName}/`,
    )
    if (named !== undefined) return named
  }
  return holds.worlds.length === 1 ? (holds.worlds[0] as FoundWorld) : null
}

/**
 * Where a file of the upload goes on the server, with the world as `levelName`: inside its folder,
 * or one of the folders beside it. Null for what isn't the world's: the rest of a server folder,
 * other worlds, and the lock a running game left.
 */
export function placeOnServer(world: FoundWorld, levelName: string): (path: string) => string | null {
  const homes = [
    { from: world.folder, to: `${levelName}/` },
    ...world.beside.map((folder) => ({
      from: folder,
      to: `${levelName}${BESIDE.find((suffix) => folder.endsWith(`${suffix}/`)) ?? ''}/`,
    })),
  ]
  // The longest first: a world at the root holds every path, the folders beside it included.
  homes.sort((a, b) => b.from.length - a.from.length)
  return (path) => {
    if (leftBySystem(path)) return null
    const home = homes.find(({ from }) => path.startsWith(from))
    if (home === undefined) return null
    const rest = path.slice(home.from.length)
    if (rest === SESSION_LOCK || rest === '') return null
    return `${home.to}${rest}`
  }
}

/**
 * What a server folder held beside the world, by name, for its owner to read: its top-level files
 * and folders that aren't the world's, at most `most` of them. Folders end in a slash.
 */
export function leftOutOf(paths: readonly string[], world: FoundWorld, most = 8): string[] {
  const place = placeOnServer(world, 'world')
  const base = world.folder === '' ? '' : folderOf(world.folder.slice(0, -1))
  const names = new Set<string>()
  for (const path of paths) {
    if (leftBySystem(path) || place(path) !== null || !path.startsWith(base)) continue
    const rest = path.slice(base.length)
    if (rest === '' || rest === `${world.folderName}/${SESSION_LOCK}`) continue
    const slash = rest.indexOf('/')
    names.add(slash === -1 ? rest : rest.slice(0, slash + 1))
  }
  return [...names].sort().slice(0, most)
}

/**
 * The mods a server folder ran with, beside the world: the jars in its `mods/`. A plugin adds no
 * block or item of its own, so a world its plugins ran on is plain Minecraft's.
 */
export function modsBeside(paths: readonly string[], world: FoundWorld): string[] {
  const base = world.folder === '' ? '' : folderOf(world.folder.slice(0, -1))
  return paths
    .filter((path) => path.startsWith(base))
    .map((path) => path.slice(base.length))
    .filter((path) => /^mods\/[^/]+\.jar$/.test(path))
}

/**
 * Where a player's own file goes in the world as the server keeps it: where the upload already
 * keeps players' files, else where the world's release keeps them (`players/data` from 26.1 on),
 * named by the dashed UUID Minecraft's files use.
 */
export function playerFilePath(
  paths: readonly string[],
  world: FoundWorld,
  levelName: string,
  gameVersion: string,
  uuid: string,
): string {
  const has = (folder: string) => paths.some((path) => path.startsWith(`${world.folder}${folder}`))
  const folder = has('players/data/')
    ? 'players/data'
    : has('playerdata/')
      ? 'playerdata'
      : compareVersions(gameVersion, '26.1') >= 0
        ? 'players/data'
        : 'playerdata'
  return `${levelName}/${folder}/${normalizeUuid(uuid)}.dat`
}

/**
 * Where a world keeps its generation settings from 26.1 on, its seed among them: in its own `data`
 * folder, or in its overworld's where Paper ran it (seen in worlds Minecraft 26.3 and Paper
 * 26.3-226 made). Before 26.1 they are in `level.dat`.
 */
export const worldGenSettingsPaths = (world: FoundWorld): string[] => [
  `${world.folder}data/minecraft/world_gen_settings.dat`,
  `${world.folder}dimensions/minecraft/overworld/data/minecraft/world_gen_settings.dat`,
]

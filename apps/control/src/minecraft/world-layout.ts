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
  // Bedrock keeps a level.dat too, beside its name and its `db` folder.
  const bedrock = (folder: string) =>
    present.has(`${folder}levelname.txt`) && files.some((path) => path.startsWith(`${folder}db/`))
  const levels = new Map<string, string>()
  let bedrockSeen = false
  for (const path of files) {
    const level = /(^|\/)level\.dat(_old)?$/.exec(path)
    if (level === null) continue
    const folder = folderOf(path)
    if (bedrock(folder)) bedrockSeen = true
    else if (level[2] === undefined || !present.has(`${folder}level.dat`)) levels.set(folder, path)
  }
  // Deepest first is no matter: a world inside another is the other's (a copy in its folder).
  const folders = [...levels.keys()].sort((a, b) => a.length - b.length)
  const outer = folders.filter((folder) => !folders.some((o) => o !== folder && folder.startsWith(o)))
  const besideOf = (folder: string): string | null => {
    for (const suffix of BESIDE)
      if (folder.endsWith(`${suffix}/`)) {
        const home = `${folder.slice(0, -suffix.length - 1)}/`
        if (home !== '/' && outer.includes(home)) return home
      }
    return null
  }
  const worlds: FoundWorld[] = outer
    .filter((folder) => besideOf(folder) === null)
    .map((folder) => ({
      folder,
      folderName: nameOf(folder),
      beside: outer.filter((other) => besideOf(other) === folder),
      levelDat: levels.get(folder) ?? `${folder}level.dat`,
    }))
  if (worlds.length === 0)
    return bedrockSeen || files.some((path) => /(^|\/)levelname\.txt$/.test(path) && bedrock(folderOf(path)))
      ? { kind: 'bedrock' }
      : { kind: 'nothing' }
  return { kind: 'java', worlds, properties: serverPropertiesOf(files, worlds) }
}

/** The `server.properties` of the folder the worlds are in, the outermost where there are several. */
function serverPropertiesOf(files: readonly string[], worlds: readonly FoundWorld[]): string | null {
  const candidates = files
    .filter((path) => /(^|\/)server\.properties$/.test(path))
    .filter((path) =>
      worlds.some((world) => world.folder !== '' && folderOf(world.folder.slice(0, -1)) === folderOf(path)),
    )
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

/** The mods and plugins a server folder ran with, beside the world: jars in its `mods/` and `plugins/`. */
export function jarsBeside(paths: readonly string[], world: FoundWorld): string[] {
  const base = world.folder === '' ? '' : folderOf(world.folder.slice(0, -1))
  return paths
    .filter((path) => path.startsWith(base))
    .map((path) => path.slice(base.length))
    .filter((path) => /^(mods|plugins)\/[^/]+\.jar$/.test(path))
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

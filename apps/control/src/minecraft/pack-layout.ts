import { isSafePath } from './mrpack.ts'

/**
 * What a pack someone uploads is, from the names of the files it holds, and where each of those
 * files goes on a server. Only names are read here; the few files that say more (a manifest, an
 * index, a start script) are read afterwards, by the reader of that format.
 *
 * The formats are the ones people bring, in the order they are recognised: a Modrinth pack, a
 * CurseForge export, a Packwiz pack, a launcher's instance (Prism, MultiMC, the CurseForge app's
 * own folder), a server pack an author published, and a plain folder of mods.
 */

type PackFormat = 'mrpack' | 'curseforge' | 'packwiz' | 'instance' | 'server' | 'mods'

export interface Detected {
  format: PackFormat
  /** The folder the pack sits in, when the archive wraps it in one: `MyPack-1.2/`, or ''. */
  root: string
  /** Where the game's own files start, below the root: `.minecraft/` in a Prism export, or ''. */
  game: string
}

/** Names a start script, JVM arguments or an installer can have at a server pack's top. */
const SERVER_SIGNS = [
  /^[^/]+\.(sh|bat|cmd|ps1|command)$/i,
  /^user_jvm_args\.txt$/,
  /^variables\.txt$/,
  /^server-setup-config\.yaml$/,
  /^eula\.txt$/,
  /^server\.properties$/,
  /^libraries\//,
  /^\.fabric\//,
  /^(neo)?forge-[^/]*\.jar$/i,
  /^(fabric|quilt)-server-[^/]*\.jar$/i,
  /^minecraft_server[^/]*\.jar$/i,
]

/**
 * The format of a pack, from its file names alone, or null when it holds nothing Blockly can
 * make a server from. `names` are the archive's files (never folders), already checked safe.
 */
export function detect(names: readonly string[]): Detected | null {
  const root = commonRoot(names)
  const inside = names.map((name) => name.slice(root.length))
  const has = (path: string) => inside.includes(path)
  const under = (dir: string) => inside.some((name) => name.startsWith(dir))

  if (has('modrinth.index.json')) return { format: 'mrpack', root, game: '' }
  if (has('manifest.json') && (under('overrides/') || has('modlist.html') || inside.length === 1))
    return { format: 'curseforge', root, game: '' }
  if (has('pack.toml') && has('index.toml')) return { format: 'packwiz', root, game: '' }
  if (has('mmc-pack.json') || has('instance.cfg')) {
    const game = under('.minecraft/') ? '.minecraft/' : under('minecraft/') ? 'minecraft/' : ''
    return { format: 'instance', root, game }
  }
  // The CurseForge app's own folder for a profile, zipped as it is.
  if (has('minecraftinstance.json')) return { format: 'instance', root, game: '' }
  const jarsOnly = inside.length > 0 && inside.every((name) => /^[^/]+\.jar$/i.test(name))
  if (!jarsOnly && inside.some((name) => SERVER_SIGNS.some((sign) => sign.test(name))))
    return { format: 'server', root, game: '' }
  if (under('mods/')) return { format: 'mods', root, game: '' }
  if (under('.minecraft/mods/')) return { format: 'mods', root, game: '.minecraft/' }
  // A folder of mods zipped from inside: the jars sit at the top.
  if (jarsOnly) return { format: 'mods', root, game: '' }
  return null
}

/**
 * The folder every file sits in, when the archive has one around the pack: an author's
 * `ServerFiles-8.2/` or a launcher's instance name. Two levels at most; a pack is never deeper.
 */
export function commonRoot(names: readonly string[]): string {
  let root = ''
  for (let depth = 0; depth < 2; depth++) {
    const first = names[0]?.slice(root.length).split('/')[0]
    if (first === undefined || names.length === 0) break
    const prefix = `${root}${first}/`
    if (!names.every((name) => name.startsWith(prefix) && name.length > prefix.length)) break
    // A pack's own folder, not a folder of the game's: `mods/` alone at the top is the pack.
    if (GAME_FOLDERS.has(first)) break
    root = prefix
  }
  return root
}

/** Folders that are the game's own, never a wrapper around a pack. */
const GAME_FOLDERS = new Set([
  'mods',
  'config',
  '.minecraft',
  'minecraft',
  'overrides',
  'kubejs',
  'defaultconfigs',
])

// ─── Where each file goes ──────────────────────────────────────────────────────────────────

/** Why a file of a pack stays out of the server. */
export type LeftOut =
  /** What only a player's game uses: resource packs, shaders, keybinds, screenshots. */
  | 'players'
  /** A world the pack carries: a server makes its own, and the owner's is never overwritten. */
  | 'world'
  /** What runs a server another way: start scripts, installers, libraries, launcher files. */
  | 'launcher'
  /** Programs for an operating system, which Minecraft never needs. */
  | 'program'
  /** Leftovers of the computer it was zipped on. */
  | 'clutter'

/** Folders only a player's game reads. */
const PLAYERS_ONLY = new Set([
  'resourcepacks',
  'shaderpacks',
  'screenshots',
  'saves',
  'journeymap',
  'xaerowaypoints',
  'xaeroworldmap',
  'schematics',
  'replay_recordings',
  'emotes',
  'customskinloader',
  'fancymenu_data',
  'itemzoom',
  'downloads',
  'backups',
])

/** Folders that belong to a launcher or to a server started another way. */
const LAUNCHER = new Set([
  'libraries',
  'versions',
  'natives',
  'assets',
  '.fabric',
  '.quilt',
  'logs',
  'crash-reports',
  '.cache',
  'cache',
  '.mixin.out',
  'patches',
])

const CLUTTER =
  /(^|\/)(__MACOSX|\.git|\.github|\.idea|\.vscode)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i

const PROGRAM = /\.(exe|dll|so|dylib|msi|app|sh|bat|cmd|ps1|command|vbs|scpt)$/i

/**
 * Where a pack's file goes on a server, relative to the server's folder, or why it stays out.
 * `path` is relative to the game's folder in the pack. Files at the very top stay out: what sits
 * there in a pack is how it was started or launched, and a server has its own settings; every
 * folder the game or a mod reads is kept, since a server pack's author put it there on purpose.
 */
export function placeOf(path: string): { path: string } | { leftOut: LeftOut } {
  if (CLUTTER.test(path)) return { leftOut: 'clutter' }
  if (PROGRAM.test(path)) return { leftOut: 'program' }
  const [top = '', ...rest] = path.split('/')
  if (rest.length === 0) return { leftOut: 'launcher' }
  const folder = top.toLowerCase()
  if (PLAYERS_ONLY.has(folder)) return { leftOut: 'players' }
  if (LAUNCHER.has(folder)) return { leftOut: 'launcher' }
  // A mod turned off in a launcher stays off.
  if (folder === 'mods' && /\.disabled$/i.test(path)) return { leftOut: 'players' }
  return isSafePath(path) ? { path } : { leftOut: 'clutter' }
}

/**
 * The folders of a pack that hold a world: every one with a `level.dat` of its own. A server
 * makes its world from the pack's mods and settings, so none of them is copied; saying which were
 * left out is the caller's.
 */
export function worldFolders(paths: readonly string[]): string[] {
  return [
    ...new Set(paths.filter((p) => /(^|\/)level\.dat$/.test(p)).map((p) => p.replace(/level\.dat$/, ''))),
  ]
}

/** Whether a file sits inside one of `folders`. */
export const insideAny = (path: string, folders: readonly string[]): boolean =>
  folders.some((folder) => folder !== '' && path.startsWith(folder))

/**
 * Whether a file of a pack is one only players' games read, where a Modrinth pack puts it: listed
 * in its index, or carried in its overrides. A dedicated server never loads shaders or resource
 * packs (the pack it sends players is a link in its properties). Cobblemon's official pack lists a
 * shader pack as needed on servers (1.8.1, 2026-09-27), which a server of it need not fetch.
 */
export function onlyForPlayers(path: string): boolean {
  const placed = placeOf(path.replace(/^(server-)?overrides\//, ''))
  return 'leftOut' in placed && placed.leftOut === 'players'
}

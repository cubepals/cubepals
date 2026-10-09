/** Reads a line of server output the way the console shows it: chat first, then severity. */

export type ConsoleLevel = 'info' | 'warn' | 'error' | 'chat' | 'setup'

// "[12:34:56] [Server thread/INFO]: message" (vanilla) or "[12:34:56 INFO]: message" (Paper).
// Thread names can hold a slash ("RCON Client /172.25.0.1 #2"), so the level is the last one.
const LOG_PATTERN =
  /^\[\d{2}:\d{2}:\d{2}(?: (?<paperLevel>[A-Z]+))?\](?: \[[^\]]*\/(?<level>[A-Z]+)\])?:? ?(?<message>.*)$/
// Players talking, and broadcasts from the console or RCON (`say`).
const CHAT_PATTERN = /^(?:\[Not Secure\] )?(?:<[A-Za-z0-9_]{1,16}>|\[(?:Server|Rcon)\]) /
// The control plane opens an RCON connection per command, and reads who is online through one
// every minute. Only the control plane can reach RCON, so these lines are its own, not the server's.
const RCON_CONNECTION = /^Thread RCON Client \/\S+ (?:started|shutting down)$/
/**
 * The image getting the server ready, before Minecraft says anything: unpacking, installing a
 * loader or a modpack, setting permissions on /data. These lines are Blockly's own work, not
 * the server's, and reading them as if the game said them is how "[init] Setting initial memory
 * to 2200M" turns into a mystery. Marked so the console can show them as setup.
 */
const SETUP_LINE =
  /^\[(?:init|mc-image-helper|mc-server-runner)\]|^\[init\] Running as uid=|^\S+\t[A-Z]+\tmc-server-runner\t/
/**
 * The server jar's own launcher, after the image and before Minecraft's log begins: the vanilla
 * bundler unpacking the libraries it carries ("Unpacking … to libraries/…"), Paperclip
 * downloading and patching Mojang's jar, and either handing over to its main class ("Starting
 * net.minecraft.server.Main"). Setup as well, not anything the game said.
 */
const LAUNCHER_LINE =
  /^(?:Unpacking \S+ \(.+\) to \S+|Starting (?:[a-z]\w*\.)+[A-Z]\w*|Downloading \S+\.jar|Applying patches)$/
/** Java's own warnings, printed before Minecraft's log begins: "WARNING: A restricted method…". */
const JAVA_WARNING = /^WARNING: /

// Terminal colour codes. Some platforms colour their own lines around the server's (a
// provider's init process can); the console shows plain text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what it matches
const TERMINAL_CODES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** The image's last word before it hands over to Java: a plain jar, or Forge's own script. */
const JAVA_STARTS = /^\[init\] (?:Starting the Minecraft server|Using Forge supplied run\.sh)/
/** Every server type says this as it makes or loads its world. */
const WORLD = /^Preparing level "/
/** Every server type's line saying where its crash report went. */
const CRASH_REPORT = /crash report (?:has been )?saved to/i

/**
 * How far a start has got, by one line of what the server printed: `starting` once the image
 * has handed over to Java, which is also the end of it downloading anything, and
 * `loading_world` once Minecraft is making or loading the world. Null for a line that says
 * neither, the image's own setup among them.
 */
export function bootMilestone(raw: string): 'starting' | 'loading_world' | null {
  const line = raw.replace(TERMINAL_CODES, '')
  if (JAVA_STARTS.test(line)) return 'starting'
  const match = LOG_PATTERN.exec(line)
  if (!match?.groups) return null
  return WORLD.test(match.groups.message ?? '') ? 'loading_world' : 'starting'
}

/**
 * Whether a line says the server wrote a crash report: "This crash report has been saved to"
 * (Minecraft), "Crash report saved to" (Forge), "Crashed! The full crash report has been saved
 * to" (Fabric and Quilt). A report means it won't come up, though its process may stay: Zombie
 * Invade 100 Days on staging (2026-09-28) wrote Forge's, then ran on without answering for ten
 * minutes.
 */
export function reportsCrash(raw: string): boolean {
  return CRASH_REPORT.test(raw.replace(TERMINAL_CODES, ''))
}

/** Null for lines the console does not show. */
export function classifyLine(raw: string): { level: ConsoleLevel; text: string } | null {
  const line = raw.replace(TERMINAL_CODES, '')
  if (SETUP_LINE.test(line) || LAUNCHER_LINE.test(line)) return { level: 'setup', text: line }
  const match = LOG_PATTERN.exec(line)
  if (!match?.groups) return { level: JAVA_WARNING.test(line) ? 'warn' : 'info', text: line }
  const message = match.groups.message ?? line
  const level = match.groups.level ?? match.groups.paperLevel ?? 'INFO'
  if (RCON_CONNECTION.test(message)) return null
  if (CHAT_PATTERN.test(message)) return { level: 'chat', text: message.replace(/^\[Not Secure\] /, '') }
  if (level === 'WARN') return { level: 'warn', text: message }
  if (level === 'ERROR' || level === 'FATAL') return { level: 'error', text: message }
  return { level: 'info', text: message }
}

// ─── What actually started ──────────────────────────────────────────────────────────────────

/** The loaders a start can be told apart by, from what they print as they start. */
type BootedLoader = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge'

/** What a start's own output says it ran; null wherever the output didn't say. */
export interface Booted {
  gameVersion: string | null
  loader: BootedLoader | null
  loaderVersion: string | null
}

// Each banner as its loader prints it (checked against their source and real server logs,
// 2026-09-26). Unanchored: Fabric prints its first lines through its own logger before
// Minecraft's takes over, and Forge's lines carry a logger name after the thread.

/** Minecraft itself, whatever runs it: "Starting minecraft server version 1.21.11 Pre-Release 1". */
const GAME_BANNER = /Starting minecraft server version (\S.*?)\s*$/
/** Fabric and Quilt: "Loading Minecraft 1.20.1 with Fabric Loader 0.16.5". */
const KNOT_BANNER = /Loading Minecraft (\S+) with (Fabric|Quilt) Loader (\S+)/
/** Fabric before 0.12, which named no version of itself. */
const OLD_FABRIC_BANNER = /Loading for game Minecraft (\S+)/
/** Forge and NeoForge from 1.13, the arguments ModLauncher starts them with. */
const MODLAUNCHER_ARGS = /ModLauncher running: args \[(.*)\]/
/** "Forge mod loading, version 47.2.0, for MC 1.20.1 with MCP …", and NeoForge's own. */
const FORGE_BANNER = /\b(Neo)?Forge mod loading, version ([^,\s]+), for MC ([^,\s]+)/
/** Forge up to 1.12. */
const OLD_FORGE_BANNER = /Forge Mod Loader version (\S+) for Minecraft (\S+) loading/
const OLD_FORGE_READY = /MinecraftForge v(\S+) Initialized/
/**
 * The vanilla bundler handing over to Minecraft. Fabric and Quilt run the same bundler, but hand
 * over to their own class (`Starting net.fabricmc.…BundlerClassPathCapture`), and Paper to
 * `org.bukkit.craftbukkit.Main`, so this line is plain Minecraft's alone.
 */
const VANILLA_BUNDLER = /^Starting net\.minecraft\.server\.Main$/
/** Fabric and Quilt, as they list what they load: "Loading 57 mods:". */
const MODS_LOADED = /\bLoading (\d+) mods?:/

/**
 * Whether a line may say what started, for keeping the few that matter from a long boot: the
 * game's banner, Fabric's and Quilt's, ModLauncher's arguments and Forge's.
 */
export const namesWhatStarted = (line: string): boolean =>
  /minecraft server version|Loading Minecraft|Loading for game|--fml\.|mod loading, version|Forge Mod Loader version|MinecraftForge v|net\.minecraft\.server\.Main/.test(
    line,
  )

/**
 * What a start ran, read from its output rather than from what it was asked to run. The game's
 * own "Starting minecraft server version" is the game version wherever it is printed; the
 * loader is the first one whose banner appears. FancyModLoader's "Starting FancyModLoader
 * version" is the version of FML inside NeoForge, not NeoForge's, and is not read.
 */
export function bootedWith(lines: readonly string[]): Booted {
  let gameVersion: string | null = null
  let bannerGame: string | null = null
  let loader: BootedLoader | null = null
  let loaderVersion: string | null = null
  let vanilla = false
  // Loader banners repeat what an earlier one said; one naming another loader is ignored.
  const saw = (found: BootedLoader, version: string | null | undefined, game: string | null | undefined) => {
    loader ??= found
    if (loader !== found) return
    loaderVersion ??= version ?? null
    bannerGame ??= game ?? null
  }
  for (const raw of lines) {
    const line = raw.replace(TERMINAL_CODES, '')
    if (SETUP_LINE.test(line)) continue
    const game = GAME_BANNER.exec(line)
    if (game !== null) gameVersion ??= game[1] ?? null
    if (VANILLA_BUNDLER.test(line)) vanilla = true
    const knot = KNOT_BANNER.exec(line)
    if (knot !== null) saw(knot[2] === 'Quilt' ? 'quilt' : 'fabric', knot[3], knot[1])
    const oldFabric = OLD_FABRIC_BANNER.exec(line)
    if (oldFabric !== null) saw('fabric', null, oldFabric[1])
    const args = MODLAUNCHER_ARGS.exec(line)?.[1]?.split(/,\s*/)
    if (args !== undefined) {
      const arg = (name: string) => {
        const at = args.indexOf(name)
        return at === -1 ? undefined : args[at + 1]
      }
      const neoForge = arg('--fml.neoForgeVersion')
      const forge = arg('--fml.forgeVersion')
      // NeoForge for 1.20.1 still launched as Forge, under its own group.
      if (neoForge !== undefined) saw('neoforge', neoForge, arg('--fml.mcVersion'))
      else if (forge !== undefined)
        saw(
          /^net\.neoforged\b/.test(arg('--fml.forgeGroup') ?? '') ? 'neoforge' : 'forge',
          forge,
          arg('--fml.mcVersion'),
        )
    }
    const forge = FORGE_BANNER.exec(line)
    if (forge !== null) saw(forge[1] === undefined ? 'forge' : 'neoforge', forge[2], forge[3])
    const oldForge = OLD_FORGE_BANNER.exec(line)
    if (oldForge !== null) saw('forge', oldForge[1], oldForge[2])
    const oldForgeReady = OLD_FORGE_READY.exec(line)
    if (oldForgeReady !== null) saw('forge', oldForgeReady[1], null)
  }
  return {
    gameVersion: gameVersion ?? bannerGame,
    loader: loader ?? (vanilla ? 'vanilla' : null),
    loaderVersion,
  }
}

/**
 * How many mods Fabric or Quilt loaded, by their own count, which takes in Minecraft, Java, the
 * loader itself and the mods other mods carry inside them. Null for loaders that don't count.
 */
export function modsLoaded(lines: readonly string[]): number | null {
  for (const raw of lines) {
    const count = MODS_LOADED.exec(raw.replace(TERMINAL_CODES, ''))?.[1]
    if (count !== undefined) return Number(count)
  }
  return null
}

const LOADER_NAMES: Readonly<Record<string, string>> = {
  vanilla: 'plain Minecraft',
  paper: 'Paper',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
}
const loaderName = (loader: string) => LOADER_NAMES[loader] ?? loader

/** "1.21" and "1.21.0" are the same release. */
const sameGame = (a: string, b: string) => a.trim().replace(/\.0$/, '') === b.trim().replace(/\.0$/, '')

/**
 * A loader build loosely: "1.20.1-47.2.0" is Forge 47.2.0, "21.1.72-beta" is NeoForge 21.1.72.
 * Null where there are no numbers to compare.
 */
function build(version: string): string | null {
  const bare = version
    .trim()
    .replace(/^v/i, '')
    .replace(/^(?:1|2\d)\.\d+(?:\.\d+)?-(?=\d)/, '')
  return /^\d+(?:\.\d+)*/.exec(bare)?.[0] ?? null
}

/**
 * The owner's sentence when what started isn't what the server was set up to run: another
 * Minecraft, another loader, or another build of the same loader. Null when they match, or where
 * the output didn't say.
 */
export function bootMismatch(
  expected: { gameVersion: string; loader: string; loaderVersion: string | null },
  booted: Booted,
): string | null {
  const game =
    booted.gameVersion !== null && !sameGame(booted.gameVersion, expected.gameVersion)
      ? booted.gameVersion
      : null
  const loader = booted.loader !== null && booted.loader !== expected.loader ? booted.loader : null
  if (game === null && loader === null) {
    if (booted.loader === null || booted.loaderVersion === null || expected.loaderVersion === null)
      return null
    const ran = build(booted.loaderVersion)
    const wanted = build(expected.loaderVersion)
    if (ran === null || wanted === null || ran === wanted) return null
    return `The server started ${loaderName(booted.loader)} ${booted.loaderVersion} instead of ${expected.loaderVersion}.`
  }
  const started =
    loader === null
      ? `Minecraft ${game}`
      : loader === 'vanilla'
        ? `plain Minecraft${game === null ? '' : ` ${game}`}`
        : game === null
          ? `with ${loaderName(loader)}`
          : `Minecraft ${game} with ${loaderName(loader)}`
  const wanted =
    loader === null
      ? expected.gameVersion
      : game === null
        ? loaderName(expected.loader)
        : expected.loader === 'vanilla'
          ? `plain Minecraft ${expected.gameVersion}`
          : `${loaderName(expected.loader)} on ${expected.gameVersion}`
  const modded = ['fabric', 'quilt', 'forge', 'neoforge'].includes(expected.loader)
  return modded
    ? `The server started ${started}, but its mods are for ${wanted}.`
    : `The server started ${started} instead of ${wanted}.`
}

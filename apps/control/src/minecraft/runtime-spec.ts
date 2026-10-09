import type { InstallSeed, RuntimeSpec } from '../app/ports/runtime.ts'
import type { ModArtifact } from '../domain/mods/artifact.ts'
import {
  type Loader,
  runsOnPaper,
  type ServerRevision,
  type ServerSettings,
} from '../domain/revision/revision.ts'
import { type MemoryTier, memoryMb } from '../domain/server/size.ts'
import type { World } from '../domain/world/world.ts'
import { DATAPACKS_STEP, datapacksEnv, datapacksOf } from './datapacks.ts'
import { DATA_DIR, jarsOf } from './jars.ts'
import { javaFor } from './versions.ts'
import { levelTypeEnv } from './worlds.ts'

/**
 * Minecraft → container. The only place that knows the itzg image's variables, Minecraft's
 * ports and how the stop timeout relates to the server's own shutdown.
 */

/** The itzg/docker-minecraft-server release every server runs. Bump deliberately. */
const IMAGE = 'itzg/minecraft-server'
const IMAGE_RELEASE = '2026.9.1'

export const GAME_PORT = 25565
const RCON_PORT = 25575
/** The server gets this long to save and stop after SIGTERM, before the image's own grace ends. */
const STOP_DURATION_SECONDS = 60

export const PORT_NAMES = { game: 'game', rcon: 'rcon' } as const

export interface RuntimeSpecInput {
  serverId: string
  revision: ServerRevision
  world: World
  memoryTier: MemoryTier
  rconPassword: string
  /** Stable link to an artifact, built by the caller from durable references (§15.2). */
  artifactUrl: (artifact: ModArtifact) => string
  /** The owner's plan limits that Minecraft itself enforces. */
  limits: PlanLimits
  /** Where the image fetches the server's icon; null when the owner picked none. */
  iconUrl: string | null
}

interface PlanLimits {
  /** Minutes a player may idle before the server kicks them; null: never. */
  playerIdleKickMinutes: number | null
  /** The world border's largest radius, in blocks; null: Minecraft's own. */
  worldRadius: number | null
  /** The disk the world lives on, in GB: the plan's for the size, or more once it grew. */
  storageGb: number
}

/**
 * The variables a plan's limits set. A plan change reaches a server at its next start or change,
 * never by itself: drift compares specs without these, so no running server restarts for one.
 */
export const PLAN_ENV: readonly string[] = ['PLAYER_IDLE_TIMEOUT', 'MAX_WORLD_SIZE']

/**
 * What the server list shows of a server: the icon the owner picked and its message. Like the
 * plan's limits they are left out of what drift compares, so changing either never restarts a
 * world someone is playing; they arrive at the next start.
 */
export const IDENTITY_ENV: readonly string[] = ['ICON', 'OVERRIDE_ICON', 'MOTD']

const TYPES: Record<Loader, string> = {
  vanilla: 'VANILLA',
  paper: 'PAPER',
  fabric: 'FABRIC',
  quilt: 'QUILT',
  neoforge: 'NEOFORGE',
  forge: 'FORGE',
}

const LOADER_VERSION_VARS: Partial<Record<Loader, string>> = {
  fabric: 'FABRIC_LOADER_VERSION',
  quilt: 'QUILT_LOADER_VERSION',
  neoforge: 'NEOFORGE_VERSION',
  forge: 'FORGE_VERSION',
  paper: 'PAPER_BUILD',
}

/**
 * How much of a server's memory becomes the Java heap; the rest is the JVM's own and the
 * system's. The capacity research measured about 400 MB of JVM native plus roughly 250 MB for
 * the OS and page cache — at least 650 MB — and warned that a flat quarter is too little on the
 * smallest sizes, where 512 MB was killed outright.
 *
 * A server running mods needs more of that room than a vanilla one: the packs measured loaded
 * 39,000 to 54,000 classes against vanilla's 25,000, and the metaspace, code cache and mixin
 * machinery live outside the heap. A live run proved the point — a modpack on the smallest size
 * with three quarters as heap sat at 93% of the container's memory before anybody joined, since
 * Aikar's flags pre-touch the whole heap at startup. Two thirds leaves a modded server about a
 * gigabyte outside the heap, and still gives it three times the live heap the research measured.
 *
 * A vanilla 3 GB server needs that gigabyte too. Five bots exploring apart on one (2026-09-28)
 * left 56 MB of the machine free with three quarters as heap, and page cache squeezed to 41 MB,
 * while the heap held at most 1,064 MB after a collection. With 2 GB as heap the same play left
 * about 400 MB free and the heap held the same 1,051 MB, with no full collection. The legacy
 * 2 GB size keeps its share: nobody measured it, and a gigabyte of heap may be too little.
 */
function heapMb(input: Pick<RuntimeSpecInput, 'revision' | 'memoryTier'>): number {
  // Datapacks are data the game reads, not classes it loads.
  const modded = input.revision.modpack !== null || jarModsOf(input.revision).length > 0
  const memory = memoryMb(input.memoryTier)
  const share = Math.floor(memory * (modded ? 0.65 : 0.75))
  return memory >= 3072 ? Math.min(share, memory - 1024) : share
}

/**
 * The Java releases the image is also built on Alpine for, at the pinned release: 21 and 25, for
 * amd64 and arm64 (Docker Hub's tags for 2026.9.1). There is no Alpine Java 8 or 17 any more.
 */
const ALPINE_JAVA: ReadonlySet<number> = new Set([21, 25])

/**
 * The image a server runs. Plain Minecraft gets the image's Alpine build where there is one: 205 MB
 * compressed against 350, and its wake on Boat came back faster. Everything that loads mods or
 * plugins, Paper included, keeps the Ubuntu build: Alpine's musl runs glibc's native libraries only
 * through gcompat, mods and plugins ship such libraries, and the image's own docs
 * say some installers fail there; datapacks ship none. A server moving between the two is a changed spec, which drift
 * applies at a moment nobody is playing.
 */
export function imageFor(
  revision: Pick<ServerRevision, 'gameVersion' | 'loader' | 'modpack'> &
    Partial<Pick<ServerRevision, 'loaderVersion' | 'mods'>>,
): string {
  const java = javaFor(revision.gameVersion)
  const plain =
    revision.loader === 'vanilla' &&
    revision.modpack === null &&
    jarModsOf({ loader: revision.loader, mods: revision.mods ?? [] }).length === 0 &&
    !runsOnPaper(revision)
  return `${IMAGE}:${IMAGE_RELEASE}-java${java}${plain && ALPINE_JAVA.has(java) ? '-alpine' : ''}`
}

/** The image's variable for each setting, which writes it into `server.properties` at every start. */
export const SETTING_ENV: Record<keyof ServerSettings, string> = {
  difficulty: 'DIFFICULTY',
  defaultGameMode: 'MODE',
  pvp: 'PVP',
  viewDistance: 'VIEW_DISTANCE',
  simulationDistance: 'SIMULATION_DISTANCE',
  maxPlayers: 'MAX_PLAYERS',
  motd: 'MOTD',
  spawnProtection: 'SPAWN_PROTECTION',
  onlineMode: 'ONLINE_MODE',
}

function settingsEnv(settings: ServerSettings): Record<string, string> {
  return {
    [SETTING_ENV.difficulty]: settings.difficulty,
    [SETTING_ENV.defaultGameMode]: settings.defaultGameMode,
    [SETTING_ENV.pvp]: String(settings.pvp),
    [SETTING_ENV.viewDistance]: String(settings.viewDistance),
    [SETTING_ENV.simulationDistance]: String(settings.simulationDistance),
    [SETTING_ENV.maxPlayers]: String(settings.maxPlayers),
    [SETTING_ENV.motd]: settings.motd,
    [SETTING_ENV.spawnProtection]: String(settings.spawnProtection),
    [SETTING_ENV.onlineMode]: settings.onlineMode ? 'TRUE' : 'FALSE',
  }
}

/**
 * player-idle-timeout kicks a player idle that many minutes (0 never does), which lets an empty
 * server's idle stop fire; max-world-size caps the world border's radius, which bounds the disk a
 * world can take (about 10.4 KB a chunk explored).
 */
function limitsEnv(limits: PlanLimits): Record<string, string> {
  return {
    PLAYER_IDLE_TIMEOUT: String(limits.playerIdleKickMinutes ?? 0),
    ...(limits.worldRadius === null ? {} : { MAX_WORLD_SIZE: String(limits.worldRadius) }),
  }
}

function worldEnv(world: World): Record<string, string> {
  return {
    LEVEL: world.levelName,
    ...levelTypeEnv(world.levelType),
    HARDCORE: String(world.hardcore),
    ...(world.seed === null ? {} : { SEED: world.seed }),
  }
}

/** The mods a revision installs as jars: all of them but its datapacks. */
function jarModsOf(revision: Pick<ServerRevision, 'loader' | 'mods'>): ServerRevision['mods'] {
  const datapacks = datapacksOf(revision)
  return revision.mods.filter((mod) => !datapacks.includes(mod))
}

/**
 * Mods are always listed for loaders that have a mods or plugins directory, even when empty:
 * an empty list makes the image remove every jar it installed, an absent one skips the cleanup.
 * A server playing a modpack lists none: the pack installs its own, and an empty list would have
 * the image delete them. Datapacks go into the world instead (`datapacks.ts`).
 */
function modsEnv(input: RuntimeSpecInput): Record<string, string> {
  if (input.revision.modpack !== null) return {}
  const jars = jarsOf(input.revision.loader)
  if (jars === null) return {}
  return {
    [jars.env]: jarModsOf(input.revision)
      .map((m) => input.artifactUrl(m.artifact))
      .join(','),
  }
}

/**
 * A modpack: the image installs the pack itself — its loader, its mods, its configuration and
 * the clean-up when it moves to another version — from the exact pack file Blockly pinned.
 */
function modpackEnv(input: RuntimeSpecInput): Record<string, string> {
  const pack = input.revision.modpack
  if (pack === null) return {}
  const leaveOut = pack.leaveOut ?? []
  // A pack's own files are left out one way, the files it carries inside itself another.
  const carried = leaveOut.filter((path) => CARRIED.test(path))
  const listed = leaveOut.filter((path) => !CARRIED.test(path))
  const overrides = carried.map((path) => path.replace(CARRIED, '')).filter((path) => !/[*?,]/.test(path))
  const properties = Object.entries(pack.javaProperties ?? {})
  return {
    MODRINTH_MODPACK: input.artifactUrl(pack.artifact),
    [PACK_VARIABLE]: pack.artifact.sha512.slice(0, 32),
    ...(listed.length === 0 ? {} : { MODRINTH_EXCLUDE_FILES: listed.map(exactPath).join('\n') }),
    // Ant-style paths inside the overrides, split at commas; a name holding `*`, `?` or a comma
    // can't be said exactly, and stays.
    ...(overrides.length === 0 ? {} : { MODRINTH_OVERRIDES_EXCLUSIONS: overrides.join('\n') }),
    // Files the pack keeps off servers that a mod of it needs after all, the same way said.
    ...((pack.forceInclude ?? []).length === 0
      ? {}
      : { MODRINTH_FORCE_INCLUDE_FILES: (pack.forceInclude ?? []).map(exactPath).join('\n') }),
    ...(properties.length === 0
      ? {}
      : { JVM_DD_OPTS: properties.map(([name, value]) => `${name}=${value}`).join(' ') }),
  }
}

/** A file a pack carries inside itself, rather than one its index lists. */
const CARRIED = /^(server-)?overrides\//

/**
 * One file of a pack, as the image's exclusion list matches it: a pattern between slashes is a
 * regular expression found in the file's lower-cased path, anything else a substring of it
 * (mc-image-helper 1.68.0 MultiMatcher). Anchored, so one file never takes another with it. The
 * list is split at commas and newlines and `#` starts a comment, so neither is written plainly.
 */
function exactPath(path: string): string {
  const escaped = path
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    .replace(/,/g, '\\x2c')
    .replace(/#/g, '\\x23')
  return `/^${escaped}$/`
}

/** Where the volume remembers which pack file it holds, and the variable naming the one pinned. */
const PACK_MARK = `${DATA_DIR}/.blockly-pack`
const PACK_VARIABLE = 'BLOCKLY_PACK'

/**
 * The image keeps the first pack it downloads from a link that isn't a Modrinth page, as
 * `/data/modpack.mrpack`, and installs that file again at every start: mc-image-helper 1.68.0
 * fetches it with `skipExisting` (ModrinthHttpPackFetcher), so a server moved to another version
 * or another pack would go on installing the old one, while saying it runs the new one (seen
 * 2026-09-26: the second pack's link, the first pack's files). So before the image starts, that
 * file goes whenever the pack pinned isn't the one it was fetched for, which the volume
 * remembers; the image then fetches the pinned one and cleans up after the old by its own
 * manifest. A world brought back from a snapshot brings its own file and its own mark.
 */
const PACK_STEP = [
  `if [ "$(cat ${PACK_MARK} 2>/dev/null)" != "$${PACK_VARIABLE}" ]; then`,
  `rm -f ${DATA_DIR}/modpack.mrpack;`,
  `printf %s "$${PACK_VARIABLE}" > ${PACK_MARK};`,
  'fi;',
]

/**
 * The image fetches the icon at every start with its Java helper, whose own start took 4 to 7 s
 * of each boot on staging (2026-09-28), where curl takes a tenth of a second. So curl fetches it
 * first: the icon already on disk leaves the image nothing to do, and another is handed to it as
 * a file, which it copies. Where curl can't fetch it, the image fetches it itself, as it did.
 */
const ICON_STEP = [
  'if [ -n "$ICON" ] && curl -fsSL --max-time 10 -o /tmp/blockly-icon "$ICON"; then',
  `if cmp -s /tmp/blockly-icon ${DATA_DIR}/server-icon.png; then unset OVERRIDE_ICON; else export ICON=/tmp/blockly-icon; fi;`,
  'fi;',
]

/**
 * Paper keeps a world's Nether and End beside it, moving `<level>/DIM-1` to
 * `<level>_nether/DIM-1` and `<level>/DIM1` to `<level>_the_end/DIM1` the first time it opens the
 * world. Every other server type reads them inside the level directory, and on its own would make
 * a new, empty Nether and End (tried 2026-10-04 with Paper 1.21.11-132 and Minecraft 1.21.11). So a
 * server that doesn't run Paper first moves them back, where they were left by a Paper one; one
 * that already has its own is left alone.
 */
const DIMENSIONS_STEP = [
  `if [ -d "${DATA_DIR}/$LEVEL" ]; then for pair in nether/DIM-1 the_end/DIM1; do`,
  `kept="${DATA_DIR}/\${LEVEL}_\${pair%/*}/\${pair#*/}"; home="${DATA_DIR}/$LEVEL/\${pair#*/}";`,
  'if [ -d "$kept" ] && [ ! -e "$home" ]; then mv "$kept" "$home"; fi;',
  'done; fi;',
].join(' ')

/**
 * The image asks Paper's API about the pinned build at every start, even with its jar on the
 * volume, and that request can wait forever: on Boat, the first start after a sandbox came back
 * from a ten-minute sleep sat at "Resolving type given PAPER" until the run gave up, its
 * connection to Paper's API open and silent (2026-10-04). A Paper server whose pinned jar the
 * image already installed (its results file names it) starts that jar as it is, with no request
 * at all; a first start, a new build or a new release still installs through the API.
 */
const PAPER_JAR_STEP = [
  `jar="${DATA_DIR}/paper-$VERSION-$PAPER_BUILD.jar";`,
  `if [ -n "$PAPER_BUILD" ] && [ -f "$jar" ] && grep -qF "$jar" ${DATA_DIR}/.paper.env 2>/dev/null;`,
  'then export PAPER_CUSTOM_JAR="$jar"; fi;',
].join(' ')

/** The image's own entrypoint, which a server's runs after Blockly's steps. */
const IMAGE_ENTRYPOINT = '/image/scripts/start'
const EXEC_IMAGE = `exec ${IMAGE_ENTRYPOINT} "$@"`

/**
 * The image's own entrypoint, after Blockly's steps. The first puts the volume's files as the
 * server type reads them (`PAPER_JAR_STEP` on Paper, `DIMENSIONS_STEP` on any other), and the
 * second the world's datapacks (`DATAPACKS_STEP`); the icon and the pack follow where a server has
 * them.
 */
function entrypointFor(steps: { paper: boolean; icon: boolean; pack: boolean }): readonly string[] {
  // The files steps lead, so `withoutFilesStep` leaves the rest as it was before them.
  const script = [
    steps.paper ? PAPER_JAR_STEP : DIMENSIONS_STEP,
    DATAPACKS_STEP,
    ...(steps.icon ? ICON_STEP : []),
    ...(steps.pack ? PACK_STEP : []),
    EXEC_IMAGE,
  ].join(' ')
  return ['/bin/sh', '-c', script, 'start']
}

/**
 * The entrypoint without its files steps, as it was before those steps existed: what drift
 * compares, so a step, which changes nothing a running server does, restarts none. It arrives at
 * the next start. What the datapacks step installs is in the environment, which drift compares.
 */
export function withoutFilesStep(entrypoint: readonly string[] | undefined): readonly string[] | undefined {
  const script = entrypoint?.[2]
  if (entrypoint === undefined || script === undefined) return entrypoint
  let rest = script
  for (const steps of [[PAPER_JAR_STEP, DIMENSIONS_STEP], [DATAPACKS_STEP]]) {
    const step = steps.find((s) => rest.startsWith(`${s} `))
    if (step !== undefined) rest = rest.slice(step.length + 1)
  }
  if (rest === script) return entrypoint
  return rest === EXEC_IMAGE ? undefined : [...entrypoint.slice(0, 2), rest, ...entrypoint.slice(3)]
}

export function toRuntimeSpec(input: RuntimeSpecInput): RuntimeSpec {
  const { revision, world, memoryTier } = input
  const totalMb = memoryMb(memoryTier)
  const onPaper = runsOnPaper(revision)
  const loaderVersionVar = onPaper ? LOADER_VERSION_VARS.paper : LOADER_VERSION_VARS[revision.loader]

  const pack = revision.modpack
  const type = pack !== null ? 'MODRINTH' : onPaper ? TYPES.paper : TYPES[revision.loader]
  const entrypoint = entrypointFor({
    paper: type === TYPES.paper,
    icon: input.iconUrl !== null,
    pack: pack !== null,
  })
  const reconstructible = reconstructibleOf(revision)

  return {
    image: imageFor(revision),
    entrypoint,
    env: {
      EULA: 'TRUE',
      // A pack decides its own server type and build, so neither is set alongside it.
      TYPE: type,
      VERSION: revision.gameVersion,
      ...(pack === null && loaderVersionVar && revision.loaderVersion
        ? { [loaderVersionVar]: revision.loaderVersion }
        : {}),
      ...modpackEnv(input),
      ...worldEnv(world),
      ...settingsEnv(revision.settings),
      ...modsEnv(input),
      ...datapacksEnv(revision, input.artifactUrl),
      ...limitsEnv(input.limits),
      // OVERRIDE_ICON, or the image keeps the first icon a world ever had.
      ...(input.iconUrl === null ? {} : { ICON: input.iconUrl, OVERRIDE_ICON: 'TRUE' }),
      // Constants of how Blockly runs Minecraft, not settings anyone changes.
      ENFORCE_WHITELIST: 'TRUE',
      ENABLE_RCON: 'TRUE',
      RCON_PORT: String(RCON_PORT),
      // The control plane is the only writer of power state (§0, decision 3).
      ENABLE_AUTOPAUSE: 'FALSE',
      ENABLE_AUTOSTOP: 'FALSE',
      MEMORY: `${heapMb(input)}M`,
      USE_AIKAR_FLAGS: 'TRUE',
      STOP_DURATION: String(STOP_DURATION_SECONDS),
    },
    secrets: { RCON_PASSWORD: input.rconPassword },
    resources: { memoryMb: totalMb },
    storage: {
      mountPath: DATA_DIR,
      sizeGb: input.limits.storageGb,
      ...(reconstructible === null ? {} : { reconstructible }),
    },
    ports: [
      { name: PORT_NAMES.game, port: GAME_PORT, protocol: 'tcp', audience: ['edge', 'control'] },
      { name: PORT_NAMES.rcon, port: RCON_PORT, protocol: 'tcp', audience: ['control'] },
    ],
    stop: { signal: 'SIGTERM', timeoutSeconds: STOP_DURATION_SECONDS + 30 },
    labels: { 'blockly.server': input.serverId },
  }
}

/**
 * What a plain Minecraft server makes again when it is missing: the jar the image downloads, its
 * record of it, and what the jar unpacks on its first start. A runtime moving the server's storage
 * may leave these behind (RuntimeSpec `reconstructible`). Loaders and packs keep everything until
 * each one's install is known to come back the same way.
 */
function reconstructibleOf(
  revision: Pick<ServerRevision, 'gameVersion' | 'loader' | 'modpack'> &
    Partial<Pick<ServerRevision, 'loaderVersion' | 'mods'>>,
): readonly string[] | null {
  const install = installOf(revision)
  return install === null ? null : [...install.paths, 'libraries', 'versions']
}

/**
 * What installing a server downloads that every server of the same release shares, for a
 * runtime to make once and copy into new servers (InstallSeed). Plain Minecraft only: its install
 * is one jar from Mojang and the manifest the image checks, which a setup-only run of the image
 * makes and a server with both skips the download (measured 2026-09-23: 20 s of a 29 s first
 * start, then 1 s). A loader or a modpack fetches most of its files once Java runs, which a
 * setup-only run never reaches, so they aren't seeded; nor is plain Minecraft run on Paper.
 */
export function installOf(
  revision: Pick<ServerRevision, 'gameVersion' | 'loader' | 'modpack'> &
    Partial<Pick<ServerRevision, 'loaderVersion' | 'mods'>>,
): InstallSeed | null {
  if (revision.loader !== 'vanilla' || revision.modpack !== null || runsOnPaper(revision)) return null
  const version = revision.gameVersion
  return {
    key: `${imageFor(revision)} VANILLA ${version}`,
    env: { EULA: 'TRUE', TYPE: 'VANILLA', VERSION: version, SETUP_ONLY: 'TRUE' },
    paths: [`minecraft_server.${version}.jar`, '.vanilla-manifest.json'],
  }
}

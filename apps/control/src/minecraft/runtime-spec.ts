// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { motdForGame } from '@blockly/contracts/server-list'
import type { InstallSeed, RuntimeSpec } from '../app/ports/runtime.ts'
import type { ModArtifact, PinnedMod } from '../domain/mods/artifact.ts'
import {
  type Loader,
  runsOnPaper,
  type ServerRevision,
  type ServerSettings,
} from '../domain/revision/revision.ts'
import { type MemoryTier, memoryMb } from '../domain/server/size.ts'
import type { World } from '../domain/world/world.ts'
import { ARCADE_DATAPACK } from './arcade.ts'
import { CARRIED_STEP, carriedEnv, placesFiles } from './carried.ts'
import { DATAPACKS_STEP, datapacksEnv, datapacksOf } from './datapacks.ts'
import { WAITING_DATAPACK } from './duels-waiting.ts'
import { DATA_DIR, JAR_LISTS, jarsOf } from './jars.ts'
import { GAME_PORT, RCON_PORT } from './ports.ts'
import { STARTER_STEP, starterEnv, starterOf } from './starter.ts'
import { javaFor } from './versions.ts'
import { UNLINKED } from './volume-links.ts'
import { WAKE_STEP } from './wake-step.ts'
import { levelTypeEnv } from './worlds.ts'

/**
 * Minecraft → container. The only place that knows the itzg image's variables, which of
 * Minecraft's ports (`ports.ts`) it opens to whom, and how the stop timeout relates to the
 * server's own shutdown.
 */

/** The itzg/docker-minecraft-server release every server runs. Bump deliberately. */
const IMAGE = 'itzg/minecraft-server'
const IMAGE_RELEASE = '2026.9.1'

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
  /**
   * The Via plugins Cubepals adds as the server starts (`app/compat/`), placed by its own step.
   * They are none of the revision's: nothing else about the spec, its heap and image included,
   * reads them.
   */
  compat?: readonly PinnedMod[]
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

/**
 * The image's word that the server reads a PROXY protocol header, which its own health check then
 * sends (`mc-monitor status --use-proxy`, from start-finalExec). Left out of what drift compares,
 * with the step that turns it on in Paper (`PAPER_PROXY_STEP`): a server running from before it
 * reads headers from its next start, and the edge knows which runs do from what each booted.
 */
export const PROXY_ENV = 'USES_PROXY_PROTOCOL'

/**
 * Whether a server of `revision` reads a PROXY protocol header before each connection: Paper does,
 * so it sees each player's own address rather than the edge's. Minecraft itself and the mod
 * loaders have no such setting, and a header sent to them breaks the connection.
 */
export function usesProxyProtocol(
  revision: Pick<ServerRevision, 'loader'> &
    Partial<Pick<ServerRevision, 'modpack' | 'loaderVersion' | 'mods'>>,
): boolean {
  return (revision.modpack ?? null) === null && (revision.loader === 'paper' || runsOnPaper(revision))
}

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

/**
 * The image's variable for each setting, which writes it into `server.properties` at every start;
 * which other versions join is Cubepals' own, and no property.
 */
export const SETTING_ENV: Record<Exclude<keyof ServerSettings, 'otherVersions'>, string> = {
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
    // The game reads its formatting codes after the section sign; owners type them with `&`.
    [SETTING_ENV.motd]: motdForGame(settings.motd),
    [SETTING_ENV.spawnProtection]: String(settings.spawnProtection),
    [SETTING_ENV.onlineMode]: settings.onlineMode ? 'TRUE' : 'FALSE',
  }
}

/**
 * player-idle-timeout kicks a player idle that many minutes (0 never does), which lets an empty
 * server's idle stop fire; max-world-size caps the world border's radius, which bounds the disk a
 * world can take (about 10.4 KB a chunk explored).
 */
/** The datapacks of Cubepals' own games, whose ways in and out Cubepals' resource pack draws. */
const OWN_GAMES = [ARCADE_DATAPACK, WAITING_DATAPACK]

/**
 * No resource pack, on a server running one of Cubepals' own games. A pack in `server.properties`
 * is offered while the player joins, and the game holds them out of the world until they answer
 * its prompt, however long that takes. Cubepals' own servers of these games offered its pack there
 * once, and one may since have stopped being Cubepals' own, so every server of them has the
 * settings written empty, which clears the pack from a world that still has it: the image keeps a
 * setting it is no longer given.
 */
function brandPackEnv(input: Pick<RuntimeSpecInput, 'revision'>): Record<string, string> {
  const ours = input.revision.files.some((file) => OWN_GAMES.some((pack) => file.path.startsWith(`${pack}/`)))
  if (!ours) return {}
  return {
    RESOURCE_PACK: '',
    RESOURCE_PACK_SHA1: '',
    RESOURCE_PACK_ID: '',
    RESOURCE_PACK_PROMPT: '',
    RESOURCE_PACK_ENFORCE: 'FALSE',
  }
}

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
 * the image delete them. Datapacks go into the world instead (`datapacks.ts`), and a plugin whose
 * jar goes in a folder of its own is placed by Blockly's step (`carried.ts`).
 */
function modsEnv(input: RuntimeSpecInput): Record<string, string> {
  if (input.revision.modpack !== null) return {}
  const jars = jarsOf(input.revision.loader)
  if (jars === null) return {}
  return {
    [jars.env]: jarModsOf(input.revision)
      .filter((m) => m.dir === undefined)
      .map((m) => input.artifactUrl(m.artifact))
      .join(','),
  }
}

/**
 * The image takes a list of jars from a file as well as from its variable (`MODS_FILE`,
 * `PLUGINS_FILE`), so a list too long for one variable, given compressed, goes to it as a file on
 * the machine's own disk, and the variable is left empty. The image keeps a record of what it
 * installed from each kind of list, and cleans up only after the kind it is given (itzg
 * 2026.9.1, `scripts/start-setupModpack`): so a volume whose jars came from a file once, which it
 * remembers, is given its list as a file from then on, however short. Its first start so removes
 * the jars the variable installed and fetches them again from the file. A server that never had a
 * long list starts as it always did.
 */
function jarListStep(variable: 'MODS' | 'PLUGINS'): string {
  const file = `/tmp/blockly-${variable.toLowerCase()}`
  const record = `.blockly-${variable.toLowerCase()}-file`
  const mark = `${DATA_DIR}/${record}`
  const { compressed } = JAR_LISTS[variable]
  return [
    `rm -f ${file}; if [ -n "$${compressed}" ]; then printf %s "$${compressed}" | base64 -d | gzip -dc > ${file} || exit 1;`,
    `elif [ -n "\${${variable}+x}" ] && [ -f ${mark} ]; then printf %s "$${variable}" | tr , '\\n' > ${file}; fi;`,
    `if [ -f ${file} ]; then export ${variable}= ${variable}_FILE=${file}; unlinked ${record}; : > ${mark}; fi;`,
  ].join(' ')
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
const PACK_RECORD = '.blockly-pack'
const PACK_MARK = `${DATA_DIR}/${PACK_RECORD}`
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
  `rm -f ${DATA_DIR}/modpack.mrpack; unlinked ${PACK_RECORD};`,
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
const DIMENSIONS_BESIDE = [
  `unlinked "$LEVEL"; if [ -d "${DATA_DIR}/$LEVEL" ]; then for pair in nether/DIM-1 the_end/DIM1; do`,
  `unlinked "\${LEVEL}_\${pair%/*}/\${pair#*/}"; unlinked "$LEVEL/\${pair#*/}";`,
  `kept="${DATA_DIR}/\${LEVEL}_\${pair%/*}/\${pair#*/}"; home="${DATA_DIR}/$LEVEL/\${pair#*/}";`,
  'if [ -d "$kept" ] && [ ! -e "$home" ]; then mv -T "$kept" "$home"; fi;',
  'done; fi;',
]

/** Where a world's files that only Paper reads are set aside, by level, when another type runs it. */
const PAPER_SET_ASIDE_RECORD = '.blockly-paper'
const PAPER_SET_ASIDE = `${DATA_DIR}/${PAPER_SET_ASIDE_RECORD}`

/**
 * From 26.1, Paper keeps a world's own state in each dimension's folder, with a `data/paper` folder
 * of its own beside it: `dimensions/minecraft/overworld/data/minecraft/world_gen_settings.dat`, where
 * Minecraft and every loader read `<level>/data/minecraft/world_gen_settings.dat`. Found 2026-10-11
 * with Paper 26.2-133: Minecraft 26.3 on such a world stopped with "Overworld settings missing"
 * before it opened, so every move off Paper rolled back. Paper's own import of a world goes the
 * other way, moving these files into each dimension (`VanillaWorldMigration`).
 *
 * So a server that doesn't run Paper, on a world Paper ran last (its overworld holds `data/paper`),
 * first puts the world's settings, game rules, weather and scheduled events back where Minecraft
 * reads them, from the overworld, and sets Paper's own files aside, with the copies Paper kept for
 * the other dimensions: Minecraft never reads them, and Paper, back on the world, imports it again
 * from what Minecraft left. The clocks Paper keeps for the whole world stay where they are.
 *
 * Both steps run as root, so each replaces any link on the way to what it moves, from or to
 * (`volume-links.ts`): nothing comes into the volume from outside it, or goes out of it.
 */
const PAPER_WORLD_STATE = [
  `w="${DATA_DIR}/$LEVEL"; if [ -d "$w/dimensions/minecraft/overworld/data/paper" ]; then`,
  'unlinked "$LEVEL/data/minecraft"; mkdir -p "$w/data/minecraft";',
  'for f in game_rules scheduled_events weather world_gen_settings; do',
  'unlinked "$LEVEL/dimensions/minecraft/overworld/data/minecraft/$f.dat"; unlinked "$LEVEL/data/minecraft/$f.dat";',
  'own="$w/dimensions/minecraft/overworld/data/minecraft/$f.dat";',
  'if [ -f "$own" ]; then mv -fT "$own" "$w/data/minecraft/$f.dat"; fi; done;',
  `unlinked "$LEVEL/dimensions"; for dim in "$w"/dimensions/*/*; do rel=\${dim#"$w"/};`,
  `for p in data/minecraft data/paper paper-world.yml; do unlinked "$LEVEL/$rel/$p"; unlinked "${PAPER_SET_ASIDE_RECORD}/$LEVEL/$rel/$p"; done;`,
  '[ -d "$dim" ] || continue;',
  `aside="${PAPER_SET_ASIDE}/$LEVEL/$rel"; mkdir -p "$aside/data/minecraft";`,
  'for f in game_rules scheduled_events weather world_gen_settings world_clocks; do unlinked "$LEVEL/$rel/data/minecraft/$f.dat";',
  'if [ -f "$dim/data/minecraft/$f.dat" ]; then mv -f "$dim/data/minecraft/$f.dat" "$aside/data/minecraft/"; fi; done;',
  'if [ -d "$dim/data/paper" ]; then rm -rf "$aside/data/paper"; mv -T "$dim/data/paper" "$aside/data/paper"; fi;',
  'if [ -f "$dim/paper-world.yml" ]; then mv -fT "$dim/paper-world.yml" "$aside/paper-world.yml"; fi;',
  'done; fi;',
]

const DIMENSIONS_STEP = [...DIMENSIONS_BESIDE, ...PAPER_WORLD_STATE].join(' ')

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

/**
 * Bukkit's connection throttle off on Paper. Every player reaches a server through the edge, so
 * the server sees one address for all of them, and the throttle, which turns away a second join
 * from an address within four seconds, turned away a friend joining just after someone else
 * ("Connection throttled!"). The edge limits joins by each player's own address instead. Paper
 * writes `bukkit.yml` at its first start and keeps it after: a server that has one gets the line
 * changed, and a new one is given the setting alone, which Paper fills out with its defaults.
 */
const PAPER_THROTTLE_STEP = [
  `unlinked bukkit.yml; if [ -f ${DATA_DIR}/bukkit.yml ]; then sed -i 's/^  connection-throttle: .*/  connection-throttle: -1/' ${DATA_DIR}/bukkit.yml;`,
  `else printf 'settings:\n  connection-throttle: -1\n' > ${DATA_DIR}/bukkit.yml; fi;`,
].join(' ')

/**
 * Paper reads a PROXY protocol header before each connection (`proxies.proxy-protocol`, in its
 * global configuration since 1.19, so on every Paper release Cubepals offers) where `PROXY_ENV`
 * says so, which tells it the player's own address: in its log, its bans and its connection
 * throttle. Paper writes `config/paper-global.yml` at its first start and keeps it after, so a
 * server that has the file gets the setting as the first line under `proxies:`, in place of any it
 * had, and a new one is given the setting alone, which Paper fills out with its defaults
 * ("assuming latest").
 *
 * The step runs as root, before the image runs the server as the volume's owner, so what it and the
 * throttle step write is handed to that owner: a `config` directory left as root's keeps Paper from
 * writing its world defaults there, and it stops at its first start, and a `bukkit.yml` left as
 * root's can't be saved (tried 2026-10-15 with Paper 1.21.1-133). Being root, the two steps replace
 * any link on the way to what they write (`volume-links.ts`), and hand over the files themselves,
 * never what a link names.
 */
const PAPER_PROXY_SETTING = 'print "proxies:"; print "  proxy-protocol: " v'
const PAPER_PROXY_STEP = [
  `v=false; if [ "$${PROXY_ENV}" = TRUE ]; then v=true; fi;`,
  'unlinked config/paper-global.yml; unlinked config/paper-global.yml.new;',
  `g=${DATA_DIR}/config/paper-global.yml; mkdir -p ${DATA_DIR}/config; if [ -f "$g" ]; then`,
  `awk -v v="$v" '/^  proxy-protocol:/ { next } /^proxies:/ { ${PAPER_PROXY_SETTING}; p = 1; next } { print }`,
  `END { if (!p) { ${PAPER_PROXY_SETTING} } }' "$g" > "$g.new" && mv -fT "$g.new" "$g";`,
  `else printf 'proxies:\\n  proxy-protocol: %s\\n' "$v" > "$g"; fi;`,
  `chown -h "$(ls -nd ${DATA_DIR} | awk '{ print $3 ":" $4 }')" ${DATA_DIR}/config "$g" ${DATA_DIR}/bukkit.yml;`,
].join(' ')

/** What a Paper server's start puts in place first: its jar, the throttle off, then the PROXY header read. */
const PAPER_STEP = `${PAPER_JAR_STEP} ${PAPER_THROTTLE_STEP} ${PAPER_PROXY_STEP}`

/** The image's own entrypoint, which a server's runs after Blockly's steps. */
const IMAGE_ENTRYPOINT = '/image/scripts/start'
const EXEC_IMAGE = `exec ${IMAGE_ENTRYPOINT} "$@"`

/**
 * The image's own entrypoint, after Blockly's steps, which run as root on the volume: before them,
 * what they call to replace a link where they write (`volume-links.ts`). The first puts the volume's files as the
 * server type reads them (`PAPER_STEP` on Paper, `DIMENSIONS_STEP` on any other), and the
 * second the world's datapacks (`DATAPACKS_STEP`); the world a template starts on
 * (`STARTER_STEP`), the icon, the pack, the files Cubepals places itself and the list of jars the
 * image installs follow where a server has them, and last what spares the image work it would
 * redo (`WAKE_STEP`).
 */
function entrypointFor(steps: {
  paper: boolean
  starter: boolean
  icon: boolean
  pack: boolean
  carried: boolean
  jars: 'MODS' | 'PLUGINS' | null
}): readonly string[] {
  const script = [
    UNLINKED,
    steps.paper ? PAPER_STEP : DIMENSIONS_STEP,
    DATAPACKS_STEP,
    ...(steps.starter ? [STARTER_STEP] : []),
    ...(steps.icon ? ICON_STEP : []),
    ...(steps.pack ? PACK_STEP : []),
    ...(steps.carried ? [CARRIED_STEP] : []),
    ...(steps.jars === null ? [] : [jarListStep(steps.jars)]),
    WAKE_STEP,
    EXEC_IMAGE,
  ].join(' ')
  return ['/bin/sh', '-c', script, 'start']
}

/**
 * The entrypoint as drift compares it: none, where it is Blockly's own steps before the image's
 * start, which every Minecraft server's is. Each step acts on what the environment says, and drift
 * compares the environment, so a new text of a step restarts no running server and boots no
 * sleeping one: it arrives at the next start.
 */
export function withoutOwnSteps(entrypoint: readonly string[] | undefined): readonly string[] | undefined {
  return entrypoint?.[2]?.endsWith(EXEC_IMAGE) === true ? undefined : entrypoint
}

export function toRuntimeSpec(input: RuntimeSpecInput): RuntimeSpec {
  const { revision, world, memoryTier } = input
  // What Cubepals' own step places: the revision's files and placed jars, and the Via plugins. A
  // Paper server told which Via plugins it starts with runs the step even with none, so the ones
  // an earlier start placed go when they are turned off.
  const placing = { ...revision, mods: [...revision.mods, ...(input.compat ?? [])] }
  const viaPlaced = input.compat !== undefined && revision.loader === 'paper' && revision.modpack === null
  const totalMb = memoryMb(memoryTier)
  const onPaper = runsOnPaper(revision)
  const loaderVersionVar = onPaper ? LOADER_VERSION_VARS.paper : LOADER_VERSION_VARS[revision.loader]

  const pack = revision.modpack
  const type = pack !== null ? 'MODRINTH' : onPaper ? TYPES.paper : TYPES[revision.loader]
  const entrypoint = entrypointFor({
    paper: type === TYPES.paper,
    starter: starterOf(world.levelType) !== null,
    icon: input.iconUrl !== null,
    pack: pack !== null,
    carried: viaPlaced || placesFiles(placing),
    jars: pack === null ? (jarsOf(revision.loader)?.env ?? null) : null,
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
      ...starterEnv(world.levelType, input.artifactUrl),
      ...settingsEnv(revision.settings),
      ...modsEnv(input),
      ...datapacksEnv(revision, input.artifactUrl),
      ...carriedEnv(revision, world.levelName, input.artifactUrl, viaPlaced ? input.compat : undefined),
      ...limitsEnv(input.limits),
      ...brandPackEnv(input),
      // OVERRIDE_ICON, or the image keeps the first icon a world ever had.
      ...(input.iconUrl === null ? {} : { ICON: input.iconUrl, OVERRIDE_ICON: 'TRUE' }),
      ...(usesProxyProtocol(revision) ? { [PROXY_ENV]: 'TRUE' } : {}),
      // Constants of how Blockly runs Minecraft, not settings anyone changes.
      ENFORCE_WHITELIST: 'TRUE',
      // Mojang's chat reporting stays on: a player's chat is signed, and a plugin may block a
      // message but never pass off another as theirs.
      ENFORCE_SECURE_PROFILE: 'TRUE',
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

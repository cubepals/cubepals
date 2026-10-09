/**
 * One player as Minecraft keeps them, and what can be done to them from the console: where they
 * are, where they last died, their game mode, what they carry, and the stats the game counts. Read
 * from a running server's console while they are on (`data get entity`), and from their own files
 * otherwise: `playerdata/<uuid>.dat` and `stats/<uuid>.json`, under `players/` from 26.1 on. Every
 * release Blockly offers words its answers and keeps its files this way, Fabric's, Forge's and
 * NeoForge's included, since a loader leaves vanilla's player data alone.
 *
 * Never writes a player's files: changes go through the console, to a player who is on.
 */

import { type Inventory, inventoryOf } from './items.ts'
import { DATA_DIR } from './jars.ts'
import { parseSnbt } from './snbt.ts'

const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'] as const
export type GameMode = (typeof GAME_MODES)[number]

/** A block in a dimension: `minecraft:overworld`, `minecraft:the_nether`… */
export interface Place {
  dimension: string
  x: number
  y: number
  z: number
}

export interface PlayerFacts {
  position: Place | null
  lastDeath: Place | null
  gameMode: GameMode | null
  inventory: Inventory
}

export interface PlayerStats {
  /** Minutes in the world, as the game counts them. */
  playMinutes: number | null
  deaths: number | null
}

/** Names a server gives players, and the only ones Blockly puts into a command. */
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The fields the page shows, in the order `parseLivePlayer` reads their answers. */
const FIELDS = [
  'Pos',
  'Dimension',
  'playerGameType',
  'LastDeathLocation',
  'Inventory',
  'EnderItems',
  'equipment',
]

/** One `data get` per field the page shows, for a player who is on. */
export function livePlayerQueries(name: string): string[] {
  return FIELDS.map((field) => `data get entity ${safeName(name)} ${field}`)
}

const HAS_DATA = /^\S+ has the following entity data: ([\s\S]*)$/
const NO_ELEMENTS = /^Found no elements matching /

/**
 * The answers to `livePlayerQueries`, in order; null where any says the player isn't on, as
 * "No entity was found" does. A field the player doesn't have yet, such as a death, is null.
 */
export function parseLivePlayer(answers: readonly (string | null)[]): PlayerFacts | null {
  const values: Record<string, unknown> = {}
  for (const [i, field] of FIELDS.entries()) {
    const answer = answers[i]?.trim()
    if (answer === undefined) return null
    const data = HAS_DATA.exec(answer)
    if (data) values[field] = parseSnbt(data[1] ?? '')
    else if (!NO_ELEMENTS.test(answer)) return null
  }
  return factsOf(values)
}

/** A player's `.dat`, decoded to plain data (prismarine-nbt's `simplify`). */
export function playerFromFile(root: unknown): PlayerFacts {
  return factsOf(typeof root === 'object' && root !== null ? (root as Record<string, unknown>) : {})
}

function factsOf(data: Record<string, unknown>): PlayerFacts {
  const pos = numbers(data.Pos)
  const dimension = dimensionOf(data.Dimension)
  const death = data.LastDeathLocation as { dimension?: unknown; pos?: unknown } | undefined
  const deathPos = numbers(death?.pos)
  const deathDimension = dimensionOf(death?.dimension)
  const mode = GAME_MODES[Number(data.playerGameType)]
  return {
    position: pos && dimension ? { dimension, x: pos[0], y: pos[1], z: pos[2] } : null,
    lastDeath:
      deathPos && deathDimension
        ? { dimension: deathDimension, x: deathPos[0], y: deathPos[1], z: deathPos[2] }
        : null,
    gameMode: mode ?? null,
    inventory: inventoryOf(data),
  }
}

function numbers(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const [x, y, z] = value.map(Number)
  return x !== undefined && y !== undefined && z !== undefined && [x, y, z].every(Number.isFinite)
    ? [x, y, z]
    : null
}

/** Dimensions are named since 1.16; Blockly offers nothing older, but a world may have come from it. */
function dimensionOf(value: unknown): string | null {
  if (typeof value === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value)) return value
  return (
    { 0: 'minecraft:overworld', [-1]: 'minecraft:the_nether', 1: 'minecraft:the_end' }[Number(value)] ?? null
  )
}

/** `stats/<uuid>.json`: time played (in ticks; `play_one_minute` before 1.17) and deaths. */
export function statsFromFile(json: unknown): PlayerStats {
  const stats = (json as { stats?: Record<string, Record<string, unknown>> } | null)?.stats ?? {}
  const custom = stats['minecraft:custom'] ?? {}
  const ticks = Number(custom['minecraft:play_time'] ?? custom['minecraft:play_one_minute'])
  const deaths = Number(custom['minecraft:deaths'] ?? 0)
  return {
    playMinutes: Number.isFinite(ticks) ? Math.floor(ticks / 20 / 60) : null,
    deaths: Number.isFinite(deaths) ? deaths : null,
  }
}

/** The world's spawn from its `level.dat`: `Data.SpawnX`…, or from 1.21.9 `Data.spawn`. */
export function worldSpawn(level: unknown): Place | null {
  const data = (level as { Data?: Record<string, unknown> } | null)?.Data
  if (data === undefined) return null
  const spawn = data.spawn as { pos?: unknown; dimension?: unknown } | undefined
  const pos = numbers(spawn?.pos) ?? numbers([data.SpawnX, data.SpawnY, data.SpawnZ])
  if (pos === null) return null
  return {
    dimension: dimensionOf(spawn?.dimension) ?? 'minecraft:overworld',
    x: pos[0],
    y: pos[1],
    z: pos[2],
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────────────────

function safeName(name: string): string {
  if (!PLAYER_NAME.test(name)) throw new Error(`Not a player name: ${name}`)
  return name
}

/** To the middle of the block where they died. */
export function teleportTo(name: string, place: Place): string[] {
  return [
    `execute in ${place.dimension} run tp ${safeName(name)} ${place.x + 0.5} ${place.y} ${place.z + 0.5}`,
  ]
}

/**
 * To the world's spawn, standing on whatever is highest there, as a respawn would put them: the
 * spawn's own height may since have been built over. Where that finds nowhere safe, the spawn
 * itself.
 */
export function teleportToSpawn(name: string, spawn: Place): string[] {
  const player = safeName(name)
  return [
    `execute in ${spawn.dimension} run spreadplayers ${spawn.x + 0.5} ${spawn.z + 0.5} 0 1 false ${player}`,
    `execute in ${spawn.dimension} run tp ${player} ${spawn.x + 0.5} ${spawn.y} ${spawn.z + 0.5}`,
  ]
}

export function setGameMode(name: string, mode: GameMode): string[] {
  return [`gamemode ${mode} ${safeName(name)}`]
}

/**
 * Whether the server did what was asked. Its refusals are the game's own words; a game mode the
 * player already has answers nothing, and is done all the same.
 */
export function accepted(answer: string): boolean {
  return !/^(No (player|entity) was found|Could not spread|Unknown or incomplete command|Incorrect argument)/.test(
    answer.trim(),
  )
}

// ─── Files ────────────────────────────────────────────────────────────────────────────────

/** How many players a snapshot keeps: the ones who played most recently. */
const SNAPSHOT_PLAYERS = 100

/**
 * One exec that prints the world's `level.dat`, then each player's data and stats, between
 * markers; binary files in base64. `recent`: the players who played most recently, newest first.
 */
export function readPlayerFiles(players: readonly string[] | 'recent'): readonly string[] {
  const chosen =
    players === 'recent'
      ? `$(ls -t "$data" 2>/dev/null | sed -n 's/^\\([0-9a-f-]\\{36\\}\\)\\.dat$/\\1/p' | head -n ${SNAPSHOT_PLAYERS})`
      : players
          .map((uuid) => {
            if (!UUID.test(uuid)) throw new Error(`Not a player UUID: ${uuid}`)
            return uuid
          })
          .join(' ')
  return [
    'sh',
    '-c',
    [
      `cd ${DATA_DIR}`,
      `level=$(sed -n 's/^level-name=//p' server.properties 2>/dev/null | tail -n 1)`,
      '[ -n "$level" ] || level=world',
      // 26.1 moved players' files under `players/`.
      'data="$level/players/data"; [ -d "$data" ] || data="$level/playerdata"',
      'stats="$level/players/stats"; [ -d "$stats" ] || stats="$level/stats"',
      `printf '@@level@@\\n'; base64 "$level/level.dat" 2>/dev/null | tr -d '\\n'; printf '\\n'`,
      `for u in ${chosen}; do [ -f "$data/$u.dat" ] || continue; ` +
        `printf '@@data %s@@\\n' "$u"; base64 "$data/$u.dat" | tr -d '\\n'; printf '\\n'; ` +
        `printf '@@stats %s@@\\n' "$u"; cat "$stats/$u.json" 2>/dev/null; printf '\\n'; done`,
    ].join('; '),
  ]
}

export interface PlayerFiles {
  /** The world's `level.dat`, gzipped as on disk; null where it has none yet. */
  level: Uint8Array | null
  players: Map<string, { data: Uint8Array; stats: string | null }>
}

export function parsePlayerFiles(stdout: string): PlayerFiles {
  const files: PlayerFiles = { level: null, players: new Map() }
  const marks = [...stdout.matchAll(/^@@(level|data|stats)(?: ([0-9a-f-]{36}))?@@$/gm)]
  marks.forEach((mark, i) => {
    const start = (mark.index ?? 0) + mark[0].length
    const body = stdout.slice(start, marks[i + 1]?.index ?? stdout.length).trim()
    if (body === '') return
    const [, kind, uuid = ''] = mark
    if (kind === 'level') files.level = fromBase64(body)
    else if (kind === 'data') files.players.set(uuid, { data: fromBase64(body), stats: null })
    else {
      const player = files.players.get(uuid)
      if (player !== undefined) player.stats = body
    }
  })
  return files
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}

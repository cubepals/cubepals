// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { isDatapack, type PinnedMod } from '../mods/artifact.ts'
import { type PinnedModpack, samePack } from '../mods/modpack.ts'
import { type CarriedFile, filesChanged, movesCarried } from './carried.ts'

export type Loader = 'vanilla' | 'paper' | 'fabric' | 'quilt' | 'neoforge' | 'forge'
type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'
export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator'

/**
 * Properties the server reads at boot. Live administration (who can join, operators, bans) is
 * not here: it lives in ServerAccess and never needs a restart.
 */
export interface ServerSettings {
  difficulty: Difficulty
  defaultGameMode: GameMode
  pvp: boolean
  viewDistance: number
  simulationDistance: number
  maxPlayers: number
  motd: string
  spawnProtection: number
  /**
   * Whether the server checks each player with Minecraft's account servers. On for every new
   * server, and never carried to another one. It changes only through its own setting, never with
   * the game settings, a rollback or a restore, because it changes which player a name belongs to
   * (§15.1): everything keyed by a player moves with it.
   */
  onlineMode: boolean
}

/** The settings the game form edits: everything but how players are checked. */
export type GameSettings = Omit<ServerSettings, 'onlineMode'>

type RevisionReason =
  | 'created'
  | 'mods_changed'
  | 'settings_changed'
  | 'version_changed'
  | 'rollback'
  | 'restore'

/** Immutable boot configuration. Every change to it is a new revision. */
export interface ServerRevision {
  id: string
  serverId: string
  number: number
  gameVersion: string
  loader: Loader
  /**
   * The build of the server software the revision pins. For plain Minecraft (`vanilla`) it is the
   * Paper build Cubepals runs it on, or null to run Mojang's own server: see `runsOnPaper`.
   */
  loaderVersion: string | null
  settings: ServerSettings
  mods: PinnedMod[]
  /**
   * The modpack this server plays, where it plays one. A pack brings its own mods and its own
   * configuration, so a revision has either a pack or a mod list, never both.
   */
  modpack: PinnedModpack | null
  /**
   * Files Cubepals wrote for what the server plays, such as a plugin's settings, written where they
   * go before every start (docs/modpack-system.md § Carried files). Empty for most servers.
   */
  files: CarriedFile[]
  /** sha512s of jars taken down where they were published that the owner chose to run anyway. */
  acknowledgedRevoked: string[]
  reason: RevisionReason
  basedOnRevisionId: string | null
  createdBy: string
}

export type RevisionDraft = Omit<ServerRevision, 'id' | 'serverId' | 'number' | 'createdBy'>

export function defaultSettings(input: {
  name: string
  gameMode: GameMode
  maxPlayers: number
}): ServerSettings {
  return {
    difficulty: 'normal',
    defaultGameMode: input.gameMode,
    pvp: true,
    viewDistance: 10,
    simulationDistance: 10,
    maxPlayers: input.maxPlayers,
    motd: welcome(input.name),
    spawnProtection: 0,
    onlineMode: true,
  }
}

/**
 * A new server's message in the server list, under its name. Not the name again, which the list
 * already shows, but a line in Blockly's words that an owner wants to make their own; a name too
 * long to quote in one line leaves just the words.
 */
export function welcome(name: string): string {
  const quoted = `"${name.trim()}", a server created by Cubepals`
  return quoted.length <= SETTING_BOUNDS.motdLength ? quoted : 'A server created by Cubepals'
}

const DIFFICULTIES: readonly Difficulty[] = ['peaceful', 'easy', 'normal', 'hard']
const GAME_MODES: readonly GameMode[] = ['survival', 'creative', 'adventure', 'spectator']

/** What the server itself accepts, and what a Minecraft client shows of a MOTD. */
export const SETTING_BOUNDS = {
  viewDistance: { min: 3, max: 32 },
  simulationDistance: { min: 3, max: 32 },
  spawnProtection: { min: 0, max: 64 },
  motdLength: 59,
} as const

/** Everything wrong with a set of settings, worded for the person changing them. */
export function settingsProblems(settings: ServerSettings, capacity: number): string[] {
  const problems: string[] = []
  const within = (value: number, bounds: { min: number; max: number }) =>
    Number.isInteger(value) && value >= bounds.min && value <= bounds.max
  if (!DIFFICULTIES.includes(settings.difficulty)) problems.push('Pick a difficulty.')
  if (!GAME_MODES.includes(settings.defaultGameMode)) problems.push('Pick a game mode.')
  if (!within(settings.viewDistance, SETTING_BOUNDS.viewDistance))
    problems.push(
      `View distance goes from ${SETTING_BOUNDS.viewDistance.min} to ${SETTING_BOUNDS.viewDistance.max} chunks.`,
    )
  if (!within(settings.simulationDistance, SETTING_BOUNDS.simulationDistance))
    problems.push(
      `Simulation distance goes from ${SETTING_BOUNDS.simulationDistance.min} to ${SETTING_BOUNDS.simulationDistance.max} chunks.`,
    )
  if (!within(settings.spawnProtection, SETTING_BOUNDS.spawnProtection))
    problems.push(`Spawn protection goes from 0 to ${SETTING_BOUNDS.spawnProtection.max} blocks.`)
  if (!Number.isInteger(settings.maxPlayers) || settings.maxPlayers < 1 || settings.maxPlayers > capacity)
    problems.push(`This size holds up to ${capacity} players. Pick a bigger size for more.`)
  const motd = settings.motd.trim()
  if (motd.length === 0 || motd.length > SETTING_BOUNDS.motdLength || /\p{Cc}/u.test(settings.motd))
    problems.push(`The message of the day is one line of up to ${SETTING_BOUNDS.motdLength} characters.`)
  return problems
}

export type RevisionChange =
  | {
      field: keyof ServerSettings
      from: ServerSettings[keyof ServerSettings]
      to: ServerSettings[keyof ServerSettings]
    }
  | { field: 'gameVersion' | 'loader' | 'loaderVersion'; from: string; to: string }
  /** Plain Minecraft moved onto Paper, or back to Mojang's own server. */
  | { field: 'onPaper'; from: boolean; to: boolean }
  | { field: 'mods'; added: string[]; removed: string[]; changed: string[] }
  | { field: 'modpack'; from: string | null; to: string | null }
  /** Files Cubepals wrote for the server, by what they set up: "LifeStealZ settings". */
  | { field: 'files'; added: string[]; removed: string[]; changed: string[] }

/** What differs from one revision to the next, in the order a person would read it. */
export function describeChanges(from: RevisionDraft, to: RevisionDraft): RevisionChange[] {
  const changes: RevisionChange[] = []
  if (from.gameVersion !== to.gameVersion)
    changes.push({ field: 'gameVersion', from: from.gameVersion, to: to.gameVersion })
  if (from.loader !== to.loader) changes.push({ field: 'loader', from: from.loader, to: to.loader })
  // A new build of the same server type; a new type brings its own build along.
  else if (
    from.loaderVersion !== null &&
    to.loaderVersion !== null &&
    from.loaderVersion !== to.loaderVersion
  )
    changes.push({ field: 'loaderVersion', from: from.loaderVersion, to: to.loaderVersion })
  if (from.loader === to.loader && runsOnPaper(from) !== runsOnPaper(to))
    changes.push({ field: 'onPaper', from: runsOnPaper(from), to: runsOnPaper(to) })
  for (const key of Object.keys(to.settings) as (keyof ServerSettings)[])
    if (from.settings[key] !== to.settings[key])
      changes.push({ field: key, from: from.settings[key], to: to.settings[key] })
  const identity = ({ source }: PinnedMod) =>
    'uploadId' in source ? `upload:${source.uploadId}` : `${source.catalog}:${source.projectId}`
  const before = new Map(from.mods.map((m) => [identity(m), m]))
  const after = new Map(to.mods.map((m) => [identity(m), m]))
  const added = [...after].filter(([id]) => !before.has(id)).map(([, m]) => m.name)
  const removed = [...before].filter(([id]) => !after.has(id)).map(([, m]) => m.name)
  const changed = [...after]
    .filter(([id, m]) => before.has(id) && before.get(id)?.artifact.sha512 !== m.artifact.sha512)
    .map(([, m]) => m.name)
  if (added.length + removed.length + changed.length > 0)
    changes.push({ field: 'mods', added, removed, changed })
  if (!samePack(from.modpack, to.modpack))
    changes.push({ field: 'modpack', from: packLabel(from.modpack), to: packLabel(to.modpack) })
  const files = filesChanged(from.files, to.files)
  if (files.added.length + files.removed.length + files.changed.length > 0)
    changes.push({ field: 'files', ...files })
  return changes
}

const packLabel = (pack: PinnedModpack | null): string | null =>
  pack === null ? null : `${pack.name} ${pack.versionLabel}`

type Booted = Pick<RevisionDraft, 'gameVersion' | 'loader'> &
  Partial<Pick<RevisionDraft, 'modpack' | 'loaderVersion' | 'files' | 'mods'>>

/**
 * Whether booting `to` on a world `from` last ran rewrites the world: a new game version
 * migrates it, and a different server type lays it out differently. Plain Minecraft moving onto
 * Paper or off it counts too: Paper keeps the Nether and the End in folders of their own. So do
 * other files Cubepals carries, or plugins it places outside the plugins folder: what a plugin made
 * of the old ones is on the disk. Rolling such a change back needs the world from before it.
 */
export function rewritesWorld(from: Booted, to: Booted): boolean {
  return (
    from.gameVersion !== to.gameVersion ||
    from.loader !== to.loader ||
    runsOnPaper(from) !== runsOnPaper(to) ||
    movesPack(from, to) ||
    movesCarried(from, to)
  )
}

/**
 * Whether plain Minecraft runs on Paper: the same game, with ticks about ten times quicker while
 * a world is being explored (mean 2 to 5 ms against vanilla's 19 to 57, measured 2026-10-04). Cubepals decides it for a new plain server where Paper has
 * a stable build for its release, and the owner can go back to Mojang's own server in its
 * settings. Only a plain revision does: no pack, and no mods but datapacks, which Paper loads
 * from the world as Minecraft does. Its Paper build is its `loaderVersion`, which plain Minecraft
 * otherwise leaves empty.
 */
export function runsOnPaper(
  revision: Pick<RevisionDraft, 'loader'> &
    Partial<Pick<RevisionDraft, 'modpack' | 'loaderVersion' | 'mods'>>,
): boolean {
  return (
    revision.loader === 'vanilla' &&
    (revision.modpack ?? null) === null &&
    (revision.mods ?? []).every((mod) => isDatapack(mod)) &&
    (revision.loaderVersion ?? null) !== null
  )
}

/**
 * Whether booting `to` puts another pack on the server than `from` ran: its mods, its configs and
 * what its mods write into the world all change together, and a pack that doesn't start leaves
 * its files behind. Such a change is installed like a deployment: a snapshot first, and the
 * snapshot back if it doesn't come up (docs/modpack-system.md § Installing).
 */
function movesPack(
  from: Partial<Pick<RevisionDraft, 'modpack'>>,
  to: Partial<Pick<RevisionDraft, 'modpack'>>,
): boolean {
  return !samePack(from.modpack ?? null, to.modpack ?? null)
}

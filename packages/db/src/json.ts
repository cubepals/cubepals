// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// Shapes stored in jsonb columns. The control plane's domain owns the meaning of these values;
// these interfaces are what the database promises to hand back. Persistence code maps between
// the two, so a drift between them is a compile error there rather than a silent mismatch.

export interface ServerSettingsJson {
  difficulty: 'peaceful' | 'easy' | 'normal' | 'hard'
  defaultGameMode: 'survival' | 'creative' | 'adventure' | 'spectator'
  pvp: boolean
  viewDistance: number
  simulationDistance: number
  maxPlayers: number
  motd: string
  spawnProtection: number
  onlineMode: boolean
}

export type ArtifactRefJson = { kind: 'remote'; url: string } | { kind: 'stored'; key: string }

export interface ModArtifactJson {
  ref: ArtifactRefJson
  sha512: string
  sizeBytes: number
  fileName: string
}

export type ModSourceJson =
  | { catalog: string; projectId: string; versionId: string }
  | { catalog: 'upload'; uploadId: string }

export interface PinnedModJson {
  source: ModSourceJson
  name: string
  versionLabel: string
  artifact: ModArtifactJson
  /** `optional` only on rows written since it existed; before, those mods were stored as `both`. */
  environment: 'server' | 'optional' | 'both'
  loaders: string[]
  gameVersions: string[]
  origin: 'user' | 'dependency'
  requiredBy: string[]
  /** The folder its jar goes in where that isn't the loader's own; absent for every other mod. */
  dir?: string
}

/** A file Cubepals wrote for a server, by its path under the server's directory. */
export interface CarriedFileJson {
  path: string
  content: string
}

/** A whole published experience a server plays, in place of a list of mods. */
export interface PinnedModpackJson {
  catalog: string
  projectId: string
  versionId: string
  name: string
  versionLabel: string
  artifact: ModArtifactJson
  /** Null for an uploaded pack with no public page. */
  page: string | null
  /** Absent on rows written before it existed, all of them packs everyone playing installs. */
  environment?: 'server' | 'both'
  /** Absent on rows written before it existed. */
  icon?: string | null
  /** Files of the pack the server leaves to players' games, by path; absent before it existed. */
  leaveOut?: string[]
  /** `-D` properties the pack starts with; absent when it has none. */
  javaProperties?: Record<string, string>
  /**
   * The curated release it is, when the server was made from one Blockly offers by name:
   * the pack's key and the exact release. Absent for any other pack.
   */
  curated?: { key: string; version: string }
  /** The file its authors published, where servers install Blockly's copy of it instead. */
  publishedFile?: string
}

/**
 * What checking a curated release found. Written once, when
 * it is verified, and never changed: it is the record of what Blockly checked and why it may offer
 * the release the way it does.
 */
export interface CuratedFactsJson {
  gameVersion: string
  loader: string
  loaderVersion: string | null
  /** The size it starts on, before anyone is counted. */
  tier: string
  /** Whether players install the pack too to join. */
  playersNeedIt: boolean
  /** How many jars a server of it runs, and what they weigh. */
  mods: number
  jarBytes: number
  /** What Blockly did with it that an owner should know, in one sentence each. */
  notes: string[]
  /**
   * The file its authors published, as fetched and checked; null for one of Blockly's own packs,
   * which nobody else publishes.
   */
  upstream: {
    catalog: string
    projectId: string
    versionId: string
    sha512: string
    sizeBytes: number
    fileName: string
    fetchedAt: string
  } | null
  /** Every file a server installs, each fetched and matched to the hash the pack lists for it. */
  checked: { files: number; bytes: number; hosts: string[] }
  /** Files that are code outside the mods folder, for a person to look at before offering it. */
  code: string[]
  /** Every work a server of it installs, with the licence its publisher declares. */
  licences: Array<{ name: string; project: string | null; licence: string | null; kind: string }>
  /** What Blockly's copy owes each work, where it keeps one. */
  obligations: Array<{ name: string; licence: string | null; owes: string[] }>
  /** What stood in the way of keeping a copy, when it is offered from its authors instead. */
  mirrorBlockers: Array<{ name: string; licence: string | null; because: string }>
}

/** A jar a pack puts on a server, with the bytes it should hold. */
export interface PackJarJson {
  path: string
  sha512: string
  sizeBytes: number
}

/** A file of a pack the server doesn't install, and why. */
export interface PackLeftOutJson {
  path: string
  /**
   * `crashed`: a mod that stopped a server of this pack as it started, being for players' games.
   * `needed`: not left out at all, the opposite: a file the pack itself keeps off servers that a mod
   * of it needs, which its servers install anyway.
   */
  why: 'players' | 'crashed' | 'needed' | 'world' | 'launcher' | 'program' | 'clutter'
}

/** What reading an uploaded pack found, once it is ready. */
export interface PackImportJson {
  /** The kind of file it was, as detected. */
  format: string
  name: string
  versionLabel: string
  gameVersion: string
  loader: string
  loaderVersion: string | null
  /** The size the pack starts on. */
  tier: string
  playersNeedIt: boolean
  mods: number
  /** When the upload is a published Modrinth pack: its project and version, to pin it as that. */
  catalog?: { projectId: string; versionId: string } | null
  /** `-D` properties the pack starts with. */
  javaProperties?: Record<string, string>
  /** Things worth saying about what was done, in the owner's words. */
  notes: string[]
}

export interface FailureJson {
  during: string
  message: string
  operationId: string
  /** What fixes it, where the failure was recognised; absent on rows written before it existed. */
  remedy?: string
}

export interface AppliedConfigJson {
  revisionId: string
  worldId: string
  memoryTier: string
  regionKey: string
  specDigest: string
  /**
   * The spec's digest without the owner's plan limits, which drift compares. Absent before plan
   * limits were in specs, when the spec digest had none of them either.
   */
  driftDigest?: string
  /** The runtime key version its secrets came from; absent before keys had versions (1). */
  secretsVersion?: number
  /**
   * Whether the server it booted reads a PROXY protocol header before each connection, which the
   * edge then sends. Absent before servers read one, and for every server that doesn't.
   */
  proxyProtocol?: boolean
  /**
   * Which of Cubepals' Via plugins its boot placed, by Modrinth project id, which decide which
   * other versions' players the edge lets in. Absent before a boot said so.
   */
  compat?: string[]
  /**
   * What its boot did with Stop cheaters' punishments file, as the server's next access sync read it:
   * `ours` where Cubepals' is in place, `own` where the owner's own Grim settings were left. Absent
   * where Stop cheaters isn't on, and before the sync read it.
   */
  stopCheaters?: 'ours' | 'own'
}

export interface ObservedJson {
  state: 'absent' | 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'unknown'
  at: string
  detail?: string
}

/**
 * Storage a rebuild elsewhere left in place rather than deleting (`server_runtimes.kept_storage`):
 * the handle that named it, and when it was kept. The leftovers sweep lets it go once it is old.
 */
export interface KeptStorageJson {
  handle: string
  at: string
}

export interface OperationProgressJson {
  step: string
  at: string
}

/** One step of an operation as `server_operations.steps` keeps it: what it began, and when (ISO). */
export interface OperationStepJson {
  step: string
  at: string
}

export interface AccessDetailsJson {
  level?: number
  bypassesPlayerLimit?: boolean
  reason?: string
  source?: string
  expiresAt?: string
}

/** One step of a server's escalation: what a player's next offence gets. */
export interface ModerationStepJson {
  kind: 'warn' | 'mute' | 'ban'
  /** How long a mute or ban lasts; null is for good. */
  minutes: number | null
}

export interface AccountRestrictionsJson {
  provisioning?: boolean
  publicListing?: boolean
  consoleCommands?: boolean
}

export interface LimitOverridesJson {
  maxServers?: number
  maxRunning?: number
  /** Play an admin granted past what the plan includes, in meter units. */
  includedUnits?: number
  /** How much of a month's block carries into the next, in place of the plan's, in meter units. */
  carryUnits?: number
  /** How long one run may last, where an admin holds this account to short runs (an AFK farm). */
  maxSessionMinutes?: number
  /** How long an empty server runs before it sleeps, in place of the plan's (the staging check's). */
  idleShutdownAfterMinutes?: number
}

export interface IneligibleReasonJson {
  code: string
  detail?: string
}

/**
 * What a world import asks its owner, where only they know (docs/world-import.md): which world,
 * when the upload holds several, and which Minecraft account played a single-player one.
 */
export interface WorldImportQuestionJson {
  /** The worlds to choose from, by folder, with what each says it is. */
  worlds?: Array<{ folder: string; name: string; gameVersion: string | null }>
  /** The world holds its single-player host's own data, which goes to the account they name. */
  player?: boolean
  /** Why the last answer didn't do, in its owner's words. */
  problem?: string
}

/** Its owner's answer: the world's folder, and the account that played it, or null for none. */
export interface WorldImportAnswerJson {
  folder?: string
  player?: string | null
}

/**
 * A world brought before its server is made, as its files say it is, and the release the server
 * made for it plays it on.
 */
export interface NewWorldFactsJson {
  /** What its player called it, or null where it says nothing. */
  name: string | null
  /** The game version that last saved it. */
  gameVersion: string
  /** The release its server runs: the one that saved it, or the next Cubepals offers. */
  playsOn: string
  seed: string | null
  levelType: string
  hardcore: boolean
  gameMode: 'survival' | 'creative' | 'adventure' | 'spectator'
  difficulty: 'peaceful' | 'easy' | 'normal' | 'hard'
  /** The world as it lies on disk once unpacked, which its server's first disk has room for. */
  sizeBytes: number
  /**
   * The modded server types that opened it, empty where only mods beside it say it was modded.
   * Absent for a world plain Minecraft opens, and on rows written before it existed.
   */
  moddedWith?: string[]
}

/** A player in a server's own access files, named as the server a world goes to knows them. */
export interface WorldPersonJson {
  uuid: string
  name: string
}

/**
 * Who could join the server a world came from: its whitelist, operators and bans, as its own files
 * listed them. Nobody is let in by reading them; its owner chooses who is.
 */
export interface WorldPeopleJson {
  /** Its server let in only the players on its whitelist. */
  whitelistOn: boolean
  whitelist: WorldPersonJson[]
  /** Each at the level its server gave them, and whether they join a full server. */
  operators: Array<WorldPersonJson & { level: number; bypassesPlayerLimit: boolean }>
  /** Each with its reason, and until when as Minecraft writes it; null for good. */
  bans: Array<WorldPersonJson & { reason: string | null; expiresAt: string | null }>
  /** Names in its files that no Minecraft account has, which are left out. */
  unknown: string[]
}

/** An uploaded world's own facts, as its server.properties and level.dat say. */
export interface UploadedWorldFactsJson {
  seed: string | null
  levelType: string
  hardcore: boolean
  /** The game version that last saved it. */
  gameVersion: string
}

/** One runtime a placement looked at (docs/runtimes.md): whether it was chosen, and why. */
export interface RuntimeConsideredJson {
  provider: string
  ruleId: string | null
  outcome: 'chosen' | 'not_matched' | 'not_in_rollout' | 'not_run' | 'no_room'
  detail: string
}

export interface PlacePointJson {
  dimension: string
  x: number
  y: number
  z: number
}

export interface ItemStackJson {
  id: string
  count: number
  name: string
  named: boolean
  enchantments: string[]
  potion: string | null
  durability: { left: number; max: number } | null
}

/** One player as their files said when their server went to sleep. */
export interface PlayerSnapshotJson {
  position: PlacePointJson | null
  lastDeath: PlacePointJson | null
  gameMode: 'survival' | 'creative' | 'adventure' | 'spectator' | null
  inventory: {
    hotbar: (ItemStackJson | null)[]
    main: (ItemStackJson | null)[]
    armor: {
      head: ItemStackJson | null
      chest: ItemStackJson | null
      legs: ItemStackJson | null
      feet: ItemStackJson | null
    }
    offhand: ItemStackJson | null
    enderChest: (ItemStackJson | null)[]
  }
  stats: { playMinutes: number | null; deaths: number | null } | null
}

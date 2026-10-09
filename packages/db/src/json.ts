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
   * The curated release it is, when the server was made from one Blockly offers by name
   * (docs/modpack-templates.md): the pack's key and the exact release. Absent for any other pack.
   */
  curated?: { key: string; version: string }
  /** The file its authors published, where servers install Blockly's copy of it instead. */
  publishedFile?: string
}

/**
 * What checking a curated release found (docs/modpack-templates.md § Ingestion). Written once, when
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
}

export interface ObservedJson {
  state: 'absent' | 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'unknown'
  at: string
  detail?: string
}

export interface OperationProgressJson {
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
  /** How long one run may last, where an admin holds this account to short runs (an AFK farm). */
  maxSessionMinutes?: number
}

export interface IneligibleReasonJson {
  code: string
  detail?: string
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

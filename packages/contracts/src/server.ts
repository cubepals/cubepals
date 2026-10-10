// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'

export const SERVER_STATUSES = [
  'provisioning',
  'stopped',
  'starting',
  'running',
  'stopping',
  'updating',
  'restoring',
  'relocating',
  'failed',
  'deleted',
  'purged',
  'storing',
  'stored',
] as const
export type ServerStatus = (typeof SERVER_STATUSES)[number]

export const STOP_REASONS = [
  'user',
  'idle',
  'policy',
  'entitlement',
  'crash',
  'maintenance',
  'session_cap',
  'hours',
  'unpaid',
] as const
export type StopReason = (typeof STOP_REASONS)[number]

export const LOADERS = ['vanilla', 'paper', 'fabric', 'quilt', 'neoforge', 'forge'] as const
export const Loader = z.enum(LOADERS)
export type Loader = z.infer<typeof Loader>

/** "What are you playing?" in the create flow. */
export const PLAY_STYLES = ['survival', 'creative'] as const
export const PlayStyle = z.enum(PLAY_STYLES)
export type PlayStyle = z.infer<typeof PlayStyle>

/** "Who is playing?" — how Blockly asks about size, never in memory or CPU. */
export const PARTY_SIZES = ['5', '10', '20', 'more'] as const
export const PartySize = z.enum(PARTY_SIZES)
export type PartySize = z.infer<typeof PartySize>

/** The size behind each answer to "Who is playing?", for public pages that show it: "3 GB". */
export interface PublicSize {
  party: PartySize
  maxPlayers: number
  memory: string
}

/** The pictures Blockly draws for a world; the same one is its icon in the multiplayer list. */
export const SERVER_ICONS = [
  'grass',
  'stone',
  'planks',
  'water',
  'diamond',
  'redstone',
  'torch',
  'chest',
  'heart',
] as const
export const ServerIcon = z.enum(SERVER_ICONS)
export type ServerIcon = z.infer<typeof ServerIcon>

/**
 * The pictures of the ways to play, as the create page shows them: each an item, drawn by
 * scripts/play-icons.py, and one for choosing a modpack instead.
 */
export const PLAY_ICONS = [
  'survival',
  'creative',
  'hardcore',
  'smooth',
  'create',
  'lifesteal',
  'manhunt',
  'skyblock',
  'oneblock',
  'rpg',
  'duels',
  'modpack',
  'ownpack',
] as const
export type PlayIcon = (typeof PLAY_ICONS)[number]
/**
 * What a server shows until its owner picks a picture, in the game's list and on its pages:
 * Blockly's own, the mark over the word. It isn't one of the choices; a server without one
 * shows it, and going back to it is picking none.
 */
export const BLOCKLY_ICON = 'blockly'

/** Words a server can carry, so the directory filters by them and nothing free-form reaches it. */
export const SERVER_TAGS = [
  'survival',
  'creative',
  'modded',
  'plugins',
  'hardcore',
  'peaceful',
  'pvp',
  'building',
  'technical',
  'adventure',
  'roleplay',
  'minigames',
  'family-friendly',
] as const
export const ServerTag = z.enum(SERVER_TAGS)
export type ServerTag = z.infer<typeof ServerTag>

export const ServerId = z.uuid()

/**
 * An invite link's code: twelve characters from the alphabet the control plane draws them from
 * (`app/servers/invites.ts`), which leaves out 0, 1 and l, the ones people misread.
 */
export const InviteCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-km-z2-9]{12}$/)

/** Where a new server's setup comes from: something Blockly offers, or a server being copied. */
export const SetupSourceInput = z.discriminatedUnion('kind', [
  /** Without a version, the newest release everything in the template runs on. */
  z.object({
    kind: z.literal('template'),
    key: z.string().trim().min(1).max(40),
    gameVersion: z.string().trim().min(1).max(20).optional(),
  }),
  z.object({
    kind: z.literal('modpack'),
    projectId: z.string().trim().min(1).max(64),
    /** The exact version to play; without one, the newest Blockly can run. */
    versionId: z.string().trim().min(1).max(64).optional(),
  }),
  /** A pack Blockly offers by name; without a version, the release it offers now. */
  z.object({
    kind: z.literal('curated'),
    key: z.string().trim().min(1).max(40),
    version: z.string().trim().min(1).max(64).optional(),
  }),
  z.object({
    kind: z.literal('server'),
    slug: z.string().trim().toLowerCase().min(3).max(40).optional(),
    /** An invite link's code, which lets a friend copy a server that isn't public. */
    invite: InviteCode.optional(),
  }),
  /** A pack its owner uploaded, once Blockly has read it and built it into one it can run. */
  z.object({ kind: z.literal('import'), importId: z.uuid() }),
])
export type SetupSourceInput = z.infer<typeof SetupSourceInput>

/**
 * A setup to look at before anything is made. The party size comes with it, because the size a
 * server lands on is the bigger of what the party needs and what the setup needs — asking
 * without it would preview a different server from the one that gets created.
 */
export const SetupRef = z.object({ from: SetupSourceInput, partySize: PartySize.optional() })

/** What Blockly offers under "what do you want to play?". */
export interface TemplateView {
  key: string
  title: string
  blurb: string
  /** Its picture; the server types for people who came looking for one go without. */
  icon: PlayIcon | null
  /** Shown under "more ways to play": for people who came looking for a server type. */
  advanced: boolean
  /** Played in an evening, so a server of it starts out as one that lasts a day. */
  forADay: boolean
  /**
   * Whether the viewer's plan runs it, and if not, why, in the words choosing it would be refused
   * with. Templates come usable first; one a plan can't run is shown dimmed, never hidden.
   */
  fits: PlanFit
}

/**
 * A pack Blockly offers by name (docs/modpack-templates.md), as the create page lists it: what it
 * is, who made it, the release a new server gets, and whether the viewer's plan runs it. Nothing
 * here names a loader or a mod: the pack brings them.
 */
export interface CuratedPackView {
  key: string
  name: string
  /** One line of what playing it is. */
  blurb: string
  /** Who made it, as they sign their work. */
  authors: string
  /** Its picture, as its authors publish it; null where it has none. */
  icon: string | null
  /** The release a new server plays. */
  version: string
  gameVersion: string
  /** Whether everyone playing installs the pack too; otherwise plain Minecraft joins. */
  playersNeedIt: boolean
  /**
   * The way to play it is, where it stands for one under "What to play": the card then carries
   * that name and picture, and the pack's own name goes beside its authors'. Null for a pack
   * offered by its own name.
   */
  way: { title: string; icon: PlayIcon } | null
  fits: PlanFit
}

/**
 * Whether the viewer's plan runs something, and if not, why, in the words choosing it would be
 * refused with, and which plan would run it: the one place the create flow offers another plan.
 */
export type PlanFit = { allowed: true } | { allowed: false; reason: string; plan: string | null }

/** A setup resolved against the catalog: what a server made from it would actually run. */
export interface SetupPreview {
  /** What is being copied or started from, by name. */
  from: string
  /**
   * The server being copied, by its own name and picture, as its page shows them; null for a
   * template or a pack. `from` names the pack instead where the server plays one.
   */
  copying: { name: string; icon: ServerIcon | null } | null
  gameVersion: string
  loader: Loader
  loaderLabel: string
  /** The mods that come with it, their dependencies included. */
  mods: string[]
  /**
   * The modpack it plays, where it plays one; then it has no mod list of its own. `both` when
   * everyone playing installs it too, `server` when it runs on the server alone and plain
   * Minecraft joins.
   */
  modpack: {
    name: string
    version: string
    /** Its page on its catalog; null for an uploaded pack that has none. */
    page: string | null
    environment: 'server' | 'both'
    /** What Blockly did with it that the owner should know, in one sentence each. */
    notes: string[]
  } | null
  /**
   * The size it needs before anyone is counted, and whether the plan runs it (its size, its
   * server type and its mods); if not, why, and which plan would.
   */
  size: { label: string; allowed: boolean; reason?: string; plan?: string | null }
}

/**
 * A modpack a server plays, by the name, version and picture people know it by, and the exact
 * version the way a player gets it: straight from its catalog, never a copy of Blockly's.
 */
export interface PackView {
  name: string
  version: string
  icon: string | null
  /** That exact version's own page on its catalog, which says what is in it; null for an upload. */
  page: string | null
  /** That version's pack file: the Modrinth App, Prism and most launchers open or import one. */
  file: string | null
  /** A link that installs that exact version in the catalog's own launcher; null where it has none. */
  app: string | null
  /** `both` when everyone playing installs it too; `server` when it runs on the server alone. */
  environment: 'server' | 'both'
}

export const CreateServerInput = z.object({
  /** Generated by the client when the create flow opens, so a retried submit is the same request. */
  idempotencyKey: z.uuid(),
  name: z.string().trim().min(1).max(40),
  slug: z.string().trim().toLowerCase().min(3).max(40).optional(),
  /** What to play. Without one, plain survival. */
  from: SetupSourceInput.optional(),
  playStyle: PlayStyle.optional(),
  partySize: PartySize,
  gameVersion: z.string().trim().min(1).max(20).optional(),
  loader: Loader.optional(),
  regionKey: z.string().trim().min(1).max(40).optional(),
  seed: z.string().trim().max(32).optional(),
  hardcore: z.boolean().optional(),
  /** Made for a while: Blockly deletes it a day later unless its owner keeps it. */
  temporary: z.boolean().optional(),
  /**
   * A server of the same owner whose first build failed, which this one takes the place of: it
   * goes to the trash, as a delete sends it, and this one takes its address. Nobody has played on
   * it, since it never started.
   */
  replaces: ServerId.optional(),
})
export type CreateServerInput = z.infer<typeof CreateServerInput>

/** A modpack someone might play, as the create flow lists them. */
export interface ModpackHit {
  projectId: string
  name: string
  summary: string
  iconUrl: string | null
  downloads: number
  /**
   * The newest Minecraft Blockly offers that this pack runs on; null when it runs on none of
   * them, which is the one thing about a pack worth saying before anybody picks it.
   */
  gameVersion: string | null
  /**
   * False for a pack made for a player's own game, which is no server at all: listed when searched
   * for by name, so it doesn't seem missing, and never picked.
   */
  runsOnServers: boolean
  /**
   * What choosing it is told when Blockly can't run it as a server, found by checking it before
   * anybody picked it (a pack that leaves mods for each player to fetch by hand, say); null when
   * it runs or hasn't been checked yet. Such a pack stays out of the default list, and a search
   * shows it dimmed with this.
   */
  refusal: string | null
  /**
   * Whether the plan of whoever is searching runs this pack, and if not, why: the same words
   * choosing it would be refused with. A pack a plan can't run is shown dimmed, never hidden.
   */
  fits: PlanFit
}

/** A link someone pasted where they search for a pack. */
export const PackLinkInput = z.object({ url: z.string().trim().min(8).max(500) })

/**
 * What a pasted link is: a pack Blockly can make a server of, at the version the link names if it
 * names one, or the one sentence that says what to do instead, with a page to do it on.
 */
export type PackLinkView =
  | { kind: 'pack'; hit: ModpackHit; versionId: string | null; versionLabel: string | null }
  | { kind: 'refused'; message: string; page: string | null }

export const PackVersionsInput = z.object({ projectId: z.string().trim().min(1).max(64) })

/** A version of a pack a server can run, as a picker lists them, newest first. */
export interface PackVersionView {
  versionId: string
  label: string
  gameVersion: string
  loaderLabel: string
  publishedAt: string
}

export const SearchModpacksInput = z.object({
  text: z.string().trim().max(100),
  offset: z.number().int().min(0).max(500).default(0),
  limit: z.number().int().min(1).max(20).default(10),
})

export const SuggestAddressInput = z.object({
  name: z.string().trim().max(40),
  slug: z.string().trim().toLowerCase().max(40).optional(),
  /** The server changing its address: an address it gave up is still its own to take back. */
  serverId: ServerId.optional(),
})

export const ServerRef = z.object({ serverId: ServerId })

export const PowerInput = z.object({
  serverId: ServerId,
  /** Distinguishes two deliberate clicks from one retried request. */
  requestId: z.uuid(),
})
export type PowerInput = z.infer<typeof PowerInput>

/** An admin stopping a server for the platform's upkeep; why is kept in the audit log. */
export const MaintenanceStopInput = PowerInput.extend({ reason: z.string().trim().min(1).max(500) })
export type MaintenanceStopInput = z.infer<typeof MaintenanceStopInput>

export const DeleteServerInput = z.object({
  serverId: ServerId,
  /** The person types the server's name to confirm; anything that destroys a world asks for it. */
  confirmName: z.string(),
})

/** Why an admin acts on someone else's server, kept in the audit log beside what was done. */
const adminReason = z.string().trim().min(1).max(500)
/** An admin starting someone's server. */
export const AdminStartInput = PowerInput.extend({ reason: adminReason })
/** An admin sending someone's server to the trash, confirmed by its name like its owner's delete. */
export const AdminTrashInput = DeleteServerInput.extend({ reason: adminReason })
/** An admin taking someone's server back out of the trash. */
export const AdminUntrashInput = ServerRef.extend({ reason: adminReason })

/** Internal progress steps; the web app words them for people. */
export const OPERATION_STEPS = [
  'queued',
  'allocating',
  'storage',
  'compute',
  'booting',
  'starting',
  'loading_world',
  'verifying',
  'access',
  'saving',
  'stopping',
  'rolling_back',
] as const
export type OperationStep = (typeof OPERATION_STEPS)[number]

export const OPERATION_KINDS = [
  'provision',
  'start',
  'stop',
  'restart',
  'apply',
  'relocate',
  'backup',
  'archive',
  'restore',
  'access_sync',
  'prune_worlds',
  'decommission',
  'purge',
  'store',
  'unstore',
] as const
export type OperationKind = (typeof OPERATION_KINDS)[number]

export interface OperationView {
  id: string
  kind: OperationKind
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  step: OperationStep | null
  error: string | null
  createdAt: string
  startedAt: string | null
}

export const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'] as const
export const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'] as const

/** Boot settings as the settings page edits them; the control plane checks the bounds. */
export const ServerSettingsInput = z.object({
  difficulty: z.enum(DIFFICULTIES),
  defaultGameMode: z.enum(GAME_MODES),
  pvp: z.boolean(),
  viewDistance: z.number().int(),
  simulationDistance: z.number().int(),
  maxPlayers: z.number().int(),
  motd: z.string().max(200),
  spawnProtection: z.number().int(),
})
/**
 * A server's settings as its pages show them: the game settings the form edits, and whether the
 * server checks players with Minecraft's account servers, which changes only through its own
 * setting (`ChangeAuthenticationInput`).
 */
export type ServerSettingsView = z.infer<typeof ServerSettingsInput> & { onlineMode: boolean }

/**
 * Every configuration change carries a request id, so a retried click is the same change, and
 * the server's version as the page showed it, so a server that changed since refuses it
 * (`changed_meanwhile`); it may say the owner runs jars taken down upstream anyway
 * (`revoked_artifacts`).
 */
const change = {
  serverId: ServerId,
  requestId: z.uuid(),
  version: z.number().int().nonnegative(),
  acknowledgeRevoked: z.boolean().optional(),
}

export const ChangeSettingsInput = z.object({ ...change, settings: ServerSettingsInput })
export const ChangeAuthenticationInput = z.object({ ...change, onlineMode: z.boolean() })
export const ChangeVersionInput = z.object({
  ...change,
  gameVersion: z.string().trim().min(1).max(20),
  loader: Loader,
  /**
   * For plain Minecraft: run it on Paper where Paper has a build for the version (true), or on
   * Mojang's own server (false). Left out, the server keeps what it runs now.
   */
  onPaper: z.boolean().optional(),
  /** The version plan's `expected`: every mod resolved again for the new version. */
  expected: z.array(z.string().regex(/^[0-9a-f]{128}$/)).max(400),
})
export const ResizeInput = z.object({ ...change, partySize: PartySize })
export const RollbackInput = z.object({ ...change, revisionId: z.uuid() })
/** What an owner calls their world, says about it, and picks for its picture. */
export const SaveIdentityInput = z.object({
  serverId: ServerId,
  name: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(1000).optional(),
  icon: ServerIcon.nullable().optional(),
  tags: z.array(ServerTag).max(5).optional(),
})
export const ChangeAddressInput = z.object({
  serverId: ServerId,
  slug: z.string().trim().toLowerCase().min(3).max(40),
})

export const REVISION_REASONS = [
  'created',
  'mods_changed',
  'settings_changed',
  'version_changed',
  'rollback',
  'restore',
] as const

/** One difference from the revision before; the web app words it. */
export type RevisionChangeView =
  | { field: string; from: string | number | boolean; to: string | number | boolean }
  | { field: 'mods'; added: string[]; removed: string[]; changed: string[] }
  /** A move between modpacks, or onto or off one; null is "no pack". */
  | { field: 'modpack'; from: string | null; to: string | null }
  /** Files Cubepals wrote for the server, named by what they set up: "LifeStealZ settings". */
  | { field: 'files'; added: string[]; removed: string[]; changed: string[] }

export interface RevisionView {
  id: string
  number: number
  reason: (typeof REVISION_REASONS)[number]
  gameVersion: string
  loader: Loader
  createdAt: string
  /** Made by the owner, rather than by Blockly or an administrator. */
  byOwner: boolean
  changes: RevisionChangeView[]
  /** What going back to this revision would change from the one the server should run now. */
  fromCurrent: RevisionChangeView[]
  /** What the server should run. */
  desired: boolean
  /** What it last booted. */
  applied: boolean
}

export interface SettingsOptions {
  bounds: {
    viewDistance: { min: number; max: number }
    simulationDistance: { min: number; max: number }
    spawnProtection: { min: number; max: number }
    motdLength: number
    /** What the current size holds. */
    maxPlayers: number
  }
  /** Versions this world can move to: the one it runs and newer. */
  gameVersions: {
    value: string
    label: string
    /** `allowed`: a server type the plan runs; the others say what they need. */
    loaders: { value: Loader; label: string; allowed: boolean; reason?: string }[]
  }[]
  partySizes: { value: PartySize; label: string; maxPlayers: number; allowed: boolean; reason?: string }[]
  /** Where the server can move to. */
  regions: { key: string; label: string }[]
  /**
   * How a running server takes a change to each game setting: `now`, as people play; at its
   * `next_start`, where only the server list shows it; or with a `restart`, where the game reads
   * it only as it starts.
   */
  takes: Record<keyof ServerSettingsView, 'now' | 'next_start' | 'restart'>
}

export interface ServerView {
  id: string
  name: string
  description: string
  icon: ServerIcon | null
  tags: string[]
  slug: string
  /** Fully formatted, ready to copy. The web app never assembles addresses. */
  joinAddress: string
  status: ServerStatus
  stopReason: StopReason | null
  /** Why it stopped on its own, when it crashed: the provider's word on the exit. */
  crash: { outOfMemory: boolean; detail: string | null; at: string | null } | null
  failure: {
    during: string
    message: string
    /**
     * What fixes it, where Blockly recognised the failure: 'more_room', 'mods', 'modpack',
     * 'restore', 'retry' or 'ours'. Null when the message stands on its own.
     */
    remedy: string | null
  } | null
  gameVersion: string
  loader: Loader
  /** The loader build the configuration pins; null for vanilla, and for revisions made before pins. */
  loaderVersion: string | null
  maxPlayers: number
  playStyle: string
  region: { key: string; label: string }
  memoryTier: string
  /** The operation currently running or queued, if any. */
  activeOperation: OperationView | null
  /** Who is on now, each with the UUID the server knows them by, which their face is found by. */
  players: { online: number; people: { name: string; uuid: string }[] } | null
  createdAt: string
  version: number
  settings: ServerSettingsView
  partySize: PartySize
  /** Stopped with changes that apply when it next starts. */
  pendingRestart: boolean
  /** When the plan's session cap stops this run; null when the plan caps none, or it isn't running. */
  sessionEndsAt: string | null
  /** The size the next change moves it to, when its plan no longer offers the one it is on. */
  movesToSize: { tier: string; label: string } | null
  /**
   * More room, when this plan sells it: the next size up, offered in one press after a server
   * runs out of memory. Null when it is already on the biggest size the plan offers.
   */
  roomier: { partySize: PartySize; label: string } | null
  /** The most recent configuration change and how it went. */
  lastChange: { status: OperationView['status']; error: string | null; at: string } | null
  /** This account's only server: a first world is where Blockly offers a next step. */
  onlyServer: boolean
  /** When a server made for a while goes away; null for one meant to last. */
  expiresAt: string | null
  /**
   * When its world is deleted for going unplayed, once that is within a month; null otherwise.
   * Playing on it, or keeping it, puts it off a year.
   */
  deletesAt: string | null
  /** How many mods or plugins it runs of its own; a modpack's aren't counted here. */
  modCount: number
  /** The modpack it plays; null when it plays none. */
  modpack: PackView | null
  /** Whether anybody has ever played on it: what Blockly offers next depends on it. */
  everPlayed: boolean
}

export interface AddressSuggestion {
  slug: string
  joinAddress: string
  available: boolean
}

export interface CreateOptions {
  templates: TemplateView[]
  /** Packs Blockly offers by name, each at the release a new server plays; usable first. */
  packs: CuratedPackView[]
  gameVersions: { value: string; label: string; recommended: boolean }[]
  loaders: { value: Loader; label: string }[]
  regions: { key: string; label: string }[]
  /** `plan`: the plan that includes a size this one doesn't. */
  partySizes: {
    value: PartySize
    label: string
    maxPlayers: number
    allowed: boolean
    reason?: string
    plan?: string | null
  }[]
  defaults: { gameVersion: string; loader: Loader; regionKey: string }
}

/** A server gone for good whose downloadable backups are still kept (§15.4: archives survive purge). */
export interface PurgedServerView {
  id: string
  name: string
  archives: number
  /** When the last of them goes; null when they are kept until deleted. */
  keptUntil: string | null
}

/** A server in its owner's trash: restorable until its purge date. */
export interface TrashedServerView {
  id: string
  name: string
  slug: string
  deletedAt: string
  /** When it is gone for good; restoring is possible until then. */
  purgeAfter: string
  /** Its backups: snapshots go with the server at purge, archives are kept for their own retention. */
  backups: { snapshots: number; archives: number }
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'
import type { Availability } from './errors.ts'
import { NAME_MAX_LENGTH, SEED_MAX_LENGTH } from './limits.ts'
import { oneLine } from './plain-text.ts'
import { type Loader, ServerId } from './server.ts'

const change = { serverId: ServerId, requestId: z.uuid() }

// ─── Backups ────────────────────────────────────────────────────────────────────────────────

export const BACKUP_TRIGGERS = [
  'scheduled',
  'sleep',
  'pre_apply',
  'pre_restore',
  'pre_relocate',
  'manual',
  'uploaded',
  'stored',
] as const
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number]

export interface BackupView {
  id: string
  trigger: BackupTrigger
  tier: 'snapshot' | 'archive'
  /** Archives are made after they're asked for; either kind can fail, and says why. */
  status: 'pending' | 'ready' | 'failed'
  error: string | null
  createdAt: string
  /** When the provider lets it go, or when an archive's retention ends; null when it stays until deleted. */
  expiresAt: string | null
  sizeBytes: number | null
  world: { id: string; name: string }
  /** The configuration the server ran when it was taken, which a restore can bring back. */
  configuration: { revisionNumber: number; gameVersion: string; loader: Loader; mods: number }
  /** Its world is from a newer game version than the server has now: only its configuration opens it. */
  needsConfiguration: boolean
}

export interface BackupsView {
  backups: BackupView[]
  /** How many of the owner's own backups the plan keeps. */
  kept: number
  /** A backup is being taken now. */
  inProgress: boolean
  /** Where the owner is, as their browser said: what a session is named by. Null until it has. */
  timeZone: string | null
  /** Downloadable archives: whether the owner can make and download them, and restore them. */
  archives: { create: Availability; restore: Availability }
}

export const CreateBackupInput = z.object(change)
export const BackupRef = z.object({ serverId: ServerId, backupId: z.uuid() })
export const ArchiveBackupInput = z.object({ ...change, backupId: z.uuid() })
/** A world download to bring back, before it is sent. */
export const BeginWorldUploadInput = z.object({
  serverId: ServerId,
  fileName: z.string().overwrite(oneLine).trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
})
export const FinishWorldUploadInput = z.object({
  serverId: ServerId,
  /** From `beginUpload`. */
  ticket: z.uuid(),
  /** What to call the world, if the server has never had it. */
  name: z.string().overwrite(oneLine).trim().max(NAME_MAX_LENGTH).optional(),
})
/** An uploaded world being brought in, by the server it is for and the ticket it was sent with. */
export const WorldImportRef = z.object({ serverId: ServerId, importId: z.uuid() })
/** What its owner answers a world import that asked: which world, and who played it. */
export const AnswerWorldImportInput = WorldImportRef.extend({
  /** The folder of the world to bring, from the ones it offered. */
  folder: z.string().max(1024).optional(),
  /** The Minecraft account that played a single-player world, or null for none. */
  player: z.string().overwrite(oneLine).trim().min(1).max(32).nullable().optional(),
})

/** A world uploaded while a server is being made, before it is sent: it has no server yet. */
export const BeginNewWorldUploadInput = BeginWorldUploadInput.omit({ serverId: true })
export const FinishNewWorldUploadInput = z.object({ ticket: z.uuid() })
/** A world uploaded while a server is being made, by the ticket it was sent with. */
export const NewWorldImportRef = z.object({ importId: z.uuid() })
export const AnswerNewWorldImportInput = AnswerWorldImportInput.omit({ serverId: true })

/**
 * A world upload as its owner sees it while it is read (docs/world-import.md): being read, asking
 * what only they know, ready as `Ready` says, or refused and why.
 */
type ImportView<Ready> = { importId: string; fileName: string } & (
  | { status: 'reading' }
  | {
      status: 'asking'
      /** The worlds the upload holds, to choose one; null where that isn't asked. */
      worlds: Array<{ folder: string; name: string; gameVersion: string | null }> | null
      /** It is a single-player world whose host's things go to the account they name. */
      player: boolean
      /** Why the last answer didn't do. */
      problem: string | null
    }
  | ({ status: 'ready'; notes: string[] } & Ready)
  | { status: 'refused'; message: string }
)

/** A player in the files of the server a world came from. */
interface WorldPerson {
  uuid: string
  name: string
}

/**
 * Who could join the server a world came from (docs/world-import.md § Who can join): nobody is let
 * in until its owner chooses (`PeopleChoice`). Null where the world came from no server's folder.
 */
export type WorldPeople = {
  /** Its server let in only the players on its whitelist. */
  whitelistOn: boolean
  whitelist: WorldPerson[]
  operators: Array<WorldPerson & { level: number; bypassesPlayerLimit: boolean }>
  /** Each with its reason, and until when as Minecraft writes it; null for good. */
  bans: Array<WorldPerson & { reason: string | null; expiresAt: string | null }>
  /** Names in its files that no Minecraft account has, left out. */
  unknown: string[]
} | null

/** The most players a server's files are read for: a large server's regulars. */
export const MOST_WORLD_PEOPLE = 200

/**
 * Who its owner lets in from the server a world came from, by UUID: each one on the whitelist,
 * and those of them who operate it. Its bans come too unless they say not to, and whether only the
 * whitelist joins is theirs to say.
 */
export const PeopleChoice = z.object({
  letIn: z.array(z.guid()).max(MOST_WORLD_PEOPLE),
  operators: z.array(z.guid()).max(MOST_WORLD_PEOPLE),
  keepBans: z.boolean(),
  whitelistOn: z.boolean(),
})
export type PeopleChoice = z.infer<typeof PeopleChoice>

/**
 * What is chosen until its owner says otherwise: nobody let in, its bans kept, and the server open
 * as a new one is. A whitelist with nobody on it would keep everyone out, its owner too, so it is
 * theirs to turn on with the players they let in.
 */
export const DEFAULT_PEOPLE_CHOICE: PeopleChoice = {
  letIn: [],
  operators: [],
  keepBans: true,
  whitelistOn: false,
}

/** Who of the players of the server a world brought for a new server came from its owner lets in. */
export const ChooseNewWorldPeopleInput = z.object({ importId: z.uuid(), ...PeopleChoice.shape })
/** Players of the server a world brought to a server came from, let into it as its owner chose. */
export const LetInFromUploadInput = WorldImportRef.extend(PeopleChoice.shape)

/** A world brought to a server: ready as a backup of it, with what Cubepals did. */
export type WorldImportView = ImportView<{ backupId: string; people: WorldPeople }>

/**
 * A world brought while a server is being made: ready as what the server is made to fit, for its
 * owner to make it from (`{ kind: 'world', importId }`).
 */
export type NewWorldImportView = ImportView<{
  world: {
    name: string
    /** The release that last saved it. */
    gameVersion: string
    /** The release its server runs: the same, or the next Cubepals offers. */
    playsOn: string
    /**
     * The modded server types that opened it (`forge`, `fabric`…), empty where only mods beside it
     * say it was modded; null for a world plain Minecraft opens. A modded world's server is made
     * from the pack it was played with (`{ kind: 'world', importId, pack }`).
     */
    moddedWith: string[] | null
  }
  /** Who could join the server it came from, for its owner to choose from. */
  people: WorldPeople
  /** Who of them its owner let in so far; null where they haven't said (`DEFAULT_PEOPLE_CHOICE`). */
  chosen: PeopleChoice | null
}>

export const RestoreBackupInput = z.object({
  ...change,
  backupId: z.uuid(),
  /** The settings and mods from then come back too. */
  withConfiguration: z.boolean(),
  acknowledgeRevoked: z.boolean().optional(),
})
/** An admin restoring one of someone's backups, as its owner would; why goes in the audit log. */
export const AdminRestoreInput = RestoreBackupInput.extend({ reason: z.string().trim().min(1).max(500) })

// ─── Worlds ─────────────────────────────────────────────────────────────────────────────────

/** The world types a person picks from when creating a world. */
export const LEVEL_TYPES = [
  'minecraft:normal',
  'minecraft:flat',
  'minecraft:large_biomes',
  'minecraft:amplified',
] as const

/**
 * Every type a world can have: those; the void, which only a template makes, as the base for
 * islands and arenas; and the Arcade's world, which a server starts on rather than generates.
 */
export const ALL_LEVEL_TYPES = [...LEVEL_TYPES, 'blockly:void', 'blockly:arcade'] as const
export type LevelType = (typeof ALL_LEVEL_TYPES)[number]

/** Whether a world's stored type is one a world can have. */
export const isLevelType = (type: string): type is LevelType =>
  (ALL_LEVEL_TYPES as readonly string[]).includes(type)

export interface WorldView {
  id: string
  name: string
  levelType: LevelType
  seed: string | null
  hardcore: boolean
  generatedOnVersion: string
  createdAt: string
  /** The world the server should run. */
  active: boolean
  /** The world the server last booted. */
  running: boolean
  backups: number
  /**
   * When the backup was taken that this world is kept in, where its files are only there: a
   * restore replaced the volume and couldn't copy the world back. Null for a world on the volume.
   */
  keptInBackupFrom: string | null
}

export const CreateWorldInput = z.object({
  ...change,
  name: z.string().overwrite(oneLine).trim().min(1).max(NAME_MAX_LENGTH),
  seed: z.string().overwrite(oneLine).trim().max(SEED_MAX_LENGTH).optional(),
  levelType: z.enum(LEVEL_TYPES),
  hardcore: z.boolean(),
})
export const SwitchWorldInput = z.object({ ...change, worldId: z.uuid() })
export const WorldRef = z.object({ serverId: ServerId, worldId: z.uuid() })

/**
 * Starting over in one step: a fresh world from a random seed, with the one it leaves kept. What it
 * is called follows what the server plays: a new season where it plays Lifesteal, another round
 * where it is made for a day, and a fresh world anywhere else.
 */
export interface FreshStartView {
  /** `islands`: each player's island lives in a world of its own, which a new world leaves alone. */
  kind: 'world' | 'round' | 'season' | 'islands'
  /** What the new world is called. */
  name: string
  /** The world it leaves. */
  leaving: string
  /** What everyone starts a new season with; null for anything but a season. */
  hearts: number | null
  /** On an island server, what players call the game and how each starts their island over. */
  islands: { mode: string; reset: string } | null
}

export const FreshStartInput = z.object(change)

// ─── Location ───────────────────────────────────────────────────────────────────────────────

export const RelocateInput = z.object({ ...change, regionKey: z.string().trim().min(1).max(40) })

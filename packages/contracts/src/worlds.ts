import { z } from 'zod'
import type { Availability } from './errors.ts'
import { type Loader, ServerId } from './server.ts'

const change = { serverId: ServerId, requestId: z.uuid() }

// ─── Backups ────────────────────────────────────────────────────────────────────────────────

export const BACKUP_TRIGGERS = [
  'scheduled',
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
  /** Downloadable archives: whether the owner can make and download them, and restore them. */
  archives: { create: Availability; restore: Availability }
}

export const CreateBackupInput = z.object(change)
export const BackupRef = z.object({ serverId: ServerId, backupId: z.uuid() })
export const ArchiveBackupInput = z.object({ ...change, backupId: z.uuid() })
/** A world download to bring back, before it is sent. */
export const BeginWorldUploadInput = z.object({
  serverId: ServerId,
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
})
export const FinishWorldUploadInput = z.object({
  serverId: ServerId,
  /** From `beginUpload`. */
  ticket: z.uuid(),
  /** What to call the world, if the server has never had it. */
  name: z.string().trim().max(40).optional(),
})
export const RestoreBackupInput = z.object({
  ...change,
  backupId: z.uuid(),
  /** The settings and mods from then come back too. */
  withConfiguration: z.boolean(),
  acknowledgeRevoked: z.boolean().optional(),
})

// ─── Worlds ─────────────────────────────────────────────────────────────────────────────────

/** The world types a person picks from when creating a world. */
export const LEVEL_TYPES = [
  'minecraft:normal',
  'minecraft:flat',
  'minecraft:large_biomes',
  'minecraft:amplified',
] as const

/**
 * Every type a world can have: those, and the void, which only a template makes, as the base for
 * islands and arenas.
 */
export type LevelType = (typeof LEVEL_TYPES)[number] | 'blockly:void'

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
}

export const CreateWorldInput = z.object({
  ...change,
  name: z.string().trim().min(1).max(40),
  seed: z.string().trim().max(32).optional(),
  levelType: z.enum(LEVEL_TYPES),
  hardcore: z.boolean(),
})
export const SwitchWorldInput = z.object({ ...change, worldId: z.uuid() })
export const WorldRef = z.object({ serverId: ServerId, worldId: z.uuid() })

// ─── Location ───────────────────────────────────────────────────────────────────────────────

export const RelocateInput = z.object({ ...change, regionKey: z.string().trim().min(1).max(40) })

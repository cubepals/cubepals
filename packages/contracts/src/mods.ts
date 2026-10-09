import { z } from 'zod'
import type { Availability } from './errors.ts'
import type { PackUpdateView } from './packs.ts'
import { Loader, type PackView, ServerId } from './server.ts'

const SHA512 = /^[0-9a-f]{128}$/

export const ModSelection = z.object({
  projectId: z.string().trim().min(1).max(64),
  /** An exact version; without one, the newest that fits the server. */
  versionId: z.string().trim().min(1).max(64).optional(),
})

/** A change to a server's mods. Nothing is written until it is applied as planned. */
export const ModChangeInput = z.object({
  serverId: ServerId,
  add: z.array(ModSelection).max(50).optional(),
  /** The owner's own uploads, by `ModUploadView.id`. */
  addUploads: z.array(z.uuid()).max(20).optional(),
  /** Mod ids as `ModView.id` gives them. */
  remove: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
  upgrade: z.union([z.literal('all'), z.array(z.string().trim().min(1).max(64)).max(200)]).optional(),
  /**
   * Work the change out on this release instead, moving the world there: what a refused plan
   * offered as `movesTo`, once the owner accepts it.
   */
  moveTo: z.string().trim().min(1).max(20).optional(),
})
export type ModChangeInput = z.infer<typeof ModChangeInput>

export const ApplyModChangeInput = ModChangeInput.extend({
  requestId: z.uuid(),
  /** The plan's `expected`: the jars the owner was shown. */
  expected: z.array(z.string().regex(SHA512)).max(400),
  acknowledgeRevoked: z.boolean().optional(),
})

export const ModSearchInput = z.object({
  serverId: ServerId,
  text: z.string().trim().max(100),
  offset: z.number().int().min(0).max(10_000).default(0),
})

export const PlanVersionInput = z.object({
  serverId: ServerId,
  gameVersion: z.string().trim().min(1).max(20),
  loader: Loader,
})

export interface ModView {
  /** The catalog project, or `upload:<id>`. */
  id: string
  name: string
  versionLabel: string
  /** Chosen by the owner, or brought in because another mod needs it. */
  origin: 'user' | 'dependency'
  requiredBy: string[]
  /** Whether players install it too, as the server's invite asks them to, or only the server has it. */
  environment: 'server' | 'both'
  source: 'catalog' | 'upload'
  /** Where people read about it. */
  url: string | null
  /** Taken down where it was published. */
  revoked: boolean
  /** It goes into the world as a datapack, and leaves plain Minecraft plain. */
  datapack: boolean
}

export interface ModsView {
  /**
   * What can be installed here: for a vanilla world, what it would take once it has a mod, or
   * datapacks alone where its release runs no mods.
   */
  kind: 'mods' | 'plugins' | 'datapacks' | null
  gameVersion: string
  loader: Loader
  /**
   * For a vanilla world: the server type adding a mod moves it to, decided by Blockly. Null when
   * the server already runs one, or when its release has none.
   */
  switchesTo: { loader: Loader; label: string } | null
  mods: ModView[]
  /**
   * The modpack this server plays. While it plays one, the mods are the pack's, so this page
   * names the pack instead of a list nobody here chose.
   */
  modpack: PackView | null
  /** For a pack server: a newer version of its pack it could move to, from the pack's catalog. */
  packUpdate: PackUpdateView | null
  /** For a pack server: its owner uploaded the pack, so a newer file takes its place. */
  packUploaded: boolean
  /** For a pack server: the pack's mods the server leaves to players' games, by name. */
  packLeftOut: string[]
  /** Whether the owner can upload their own jars here: the policy's own answer. */
  uploads: Availability
}

export interface ModSearchHit {
  projectId: string
  slug: string
  name: string
  summary: string
  iconUrl: string | null
  downloads: number
  installed: boolean
  /**
   * False when every version only runs in players' games. Such a mod is only ever found by its
   * name: it is left out of what a search suggests before anybody types.
   */
  runsOnServers: boolean
}

/** Why mods can't run together; the web app words each kind. */
export type ModConflictView =
  | { kind: 'unavailable'; mod: string; projectId: string }
  | { kind: 'no_fitting_version'; mod: string; projectId: string }
  | { kind: 'client_only'; mod: string; projectId: string }
  | { kind: 'missing_dependency'; mod: string; projectId: string; dependency: string }
  | { kind: 'incompatible'; mod: string; projectId: string; with: string }
  | { kind: 'upload_does_not_fit'; mod: string }

export type ModPlanView =
  | {
      kind: 'ok'
      /** The server type it runs on: a vanilla world stays vanilla while it adds only datapacks. */
      loader: Loader
      added: ModView[]
      removed: ModView[]
      updated: Array<{ from: ModView; to: ModView }>
      /** Mods taken down where they were published: applying needs `acknowledgeRevoked`. */
      revoked: ModView[]
      /** Send back with the change, so what is applied is what was shown. */
      expected: string[]
    }
  | {
      kind: 'conflicts'
      conflicts: ModConflictView[]
      /**
       * A newer Minecraft where the same change works. Blockly offers the move rather than making
       * it: a world only ever moves forward, and that is the owner's call.
       */
      movesTo: { gameVersion: string } | null
    }

// ─── Uploads ────────────────────────────────────────────────────────────────────────────────

export const BeginModUploadInput = z.object({
  serverId: ServerId,
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  /** Hex SHA-512 of the file, computed in the browser. */
  sha512: z.string().regex(SHA512),
})
export const ModUploadRef = z.object({ serverId: ServerId, uploadId: z.uuid() })
/** The upload a `ticket` from `beginUpload` stands for, sent: check it and keep it. */
export const FinishModUploadInput = z.object({ serverId: ServerId, ticket: z.uuid() })

/** A jar the owner uploaded; it can go on any of their servers it fits. */
export interface ModUploadView {
  id: string
  fileName: string
  name: string
  version: string
  /** The server types it declares, as the catalog names them. */
  loaders: string[]
  sizeBytes: number
  createdAt: string
  /** A server still has it, so it can't be deleted. */
  inUse: boolean
  /** It would run on this server as the server is now. */
  fits: boolean
}

/**
 * Where to put the file, with a ticket to finish it by; or the upload that already holds these
 * bytes. A ticket is not an upload: `finishUpload` turns it into one.
 */
export type UploadStartView =
  | { kind: 'known'; uploadId: string }
  | { kind: 'upload'; ticket: string; url: string; headers: Record<string, string> }

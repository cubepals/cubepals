import { z } from 'zod'
import { ServerId } from './server.ts'

/**
 * A pack someone brings in a file: a Modrinth pack, a server pack, a launcher's export or a
 * folder of mods, whichever it is. Blockly reads it, works out what it runs on and builds a pack
 * it can install; the person only ever sees what the pack is, or one sentence on why it can't run.
 */

/** Starting an upload: what the browser knows about the file before sending it. */
export const BeginPackUploadInput = z.object({
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
})

/** The upload a `ticket` stands for, sent: read it and build the pack. */
export const FinishPackUploadInput = z.object({ ticket: z.uuid() })

export const PackImportRef = z.object({ importId: z.uuid() })

/** Where to put the file, and the ticket that finishes it. */
export interface PackUploadStartView {
  ticket: string
  url: string
  headers: Record<string, string>
}

/** An uploaded pack, being read, ready to play, or refused with its reason. */
export type PackImportView =
  | { status: 'reading'; importId: string; fileName: string }
  | {
      status: 'ready'
      importId: string
      fileName: string
      pack: {
        name: string
        version: string
        gameVersion: string
        loaderLabel: string
        /** How many mods the server runs. */
        mods: number
        /** Whether players install it too to join. */
        playersNeedIt: boolean
        /** What Blockly did with it that the owner should know, in one sentence each. */
        notes: string[]
      }
    }
  | { status: 'refused'; importId: string; fileName: string; message: string }

/** A newer version of the pack a server plays, which its owner may move to. */
export interface PackUpdateView {
  versionId: string
  label: string
  gameVersion: string
  /** Moving to it moves the world to a newer Minecraft, which can't be undone. */
  movesWorld: boolean
  /**
   * The curated release it is, where the server plays a pack Blockly offers by name: moving to it
   * names this release, never a catalog version. Null for any other pack.
   */
  release: string | null
}

/** Changing the pack a server plays: another version of it, or a pack its owner uploaded. */
export const ChangePackInput = z.object({
  serverId: ServerId,
  requestId: z.uuid(),
  /** The server's revision version the owner looked at, so a change nobody saw isn't overwritten. */
  version: z.number().int().nonnegative(),
  acknowledgeRevoked: z.boolean().optional(),
  to: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('catalog'), versionId: z.string().trim().min(1).max(64) }),
    /** Another release of the pack Blockly offers by name that the server plays. */
    z.object({ kind: z.literal('curated'), version: z.string().trim().min(1).max(64) }),
    z.object({ kind: z.literal('import'), importId: z.uuid() }),
  ]),
})

// ─── Curated packs, for admins (docs/modpack-templates.md) ──────────────────────────────────

/** One reviewed release of a curated pack, by its key and version. */
export const CuratedReleaseInput = z.object({
  key: z.string().trim().min(1).max(40),
  version: z.string().trim().min(1).max(64),
})

/** Taking a release from new servers, and why, for the audit log and the next admin. */
export const WithdrawReleaseInput = CuratedReleaseInput.extend({
  reason: z.string().trim().min(1).max(300),
})

/** A reviewed pack and each of its releases as checking left it. */
export interface CuratedPackAdminView {
  key: string
  name: string
  authors: string
  /** The most the review lets Blockly do with its files. */
  distribution: 'mirror' | 'upstream'
  /** Where the review is written up. */
  review: string
  /** Why no admin may offer it yet, where the review holds it; null when nothing does. */
  held: string | null
  releases: CuratedReleaseAdminView[]
}

export interface CuratedReleaseAdminView {
  version: string
  state: 'pending' | 'verified' | 'published' | 'withdrawn' | 'refused'
  /** How servers get its files, once verified. */
  distribution: 'mirror' | 'upstream' | null
  /** Why checking it refused it, and the detail behind that. */
  refusal: string | null
  detail: string | null
  withdrawnReason: string | null
  changedBy: string
  verifiedAt: string | null
  publishedAt: string | null
  withdrawnAt: string | null
  /** What checking it found, once verified. */
  facts: {
    gameVersion: string
    loaderLabel: string
    mods: number
    /** Files a server installs, each matched to its hash, and the hosts they came from. */
    checkedFiles: number
    hosts: string[]
    /** How many of the works in it carry each kind of licence. */
    licences: Record<string, number>
    /** What stands in the way of Blockly keeping its own copy. */
    mirrorBlockers: string[]
    /** Files that run as code besides its mods, for a person to look at. */
    code: string[]
  } | null
}

/** A version Cubepals ran on a release its catalog doesn't list it for, as admins see it. */
export interface TestedVersionAdminView {
  name: string
  versionLabel: string
  gameVersion: string
  loaderLabel: string
  /** The server build it ran on. */
  build: string
  /** `YYYY-MM-DD`. */
  testedOn: string
  testedBy: string
  evidence: string
}

/** A template that brings plugins or mods, and whether they keep up with what Cubepals offers. */
export interface TemplateCompatibilityAdminView {
  key: string
  title: string
  loaderLabel: string
  /** The newest release Cubepals offers for its server type. */
  newest: string
  /**
   * `current`: every plugin lists the newest release. `covered`: a tested version stands in for
   * each that doesn't. `lagging`: some hold the template back, named in `behind`.
   */
  status: 'current' | 'covered' | 'lagging'
  /** The plugins that hold it back, each with the newest release it lists. */
  behind: Array<{ name: string; newestListed: string | null }>
  /** The tested versions that carry it to the newest release. */
  tested: TestedVersionAdminView[]
}

export interface CompatibilityAdminView {
  templates: TemplateCompatibilityAdminView[]
  /** Every version Cubepals tested past its listing. */
  tested: TestedVersionAdminView[]
}

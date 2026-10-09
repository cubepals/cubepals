import { z } from 'zod'
import type { ReactionsView } from './guestbook.ts'
import { type Loader, ServerId, ServerTag } from './server.ts'

/** Why a listing isn't shown, beyond its owner's choice and moderation. */
export type IneligibleCode =
  | 'not_running_yet'
  | 'untrusted_mods'
  | 'account_not_active'
  | 'restricted'
  | 'not_entitled'
  | 'server_deleted'

/** A server as the directory shows it: the server's own identity, and how it is doing now. */
export interface ListingCardView {
  serverId: string
  slug: string
  name: string
  description: string
  icon: string | null
  tags: string[]
  joinAddress: string
  /** Players online now; a sleeping server wakes when someone joins. */
  online: number
  awake: boolean
  /** When someone was last on it, for "recently active". */
  lastPlayedAt: string | null
  whitelistOnly: boolean
  gameVersion: string | null
  loader: Loader | null
  /** Vanilla, or mods Blockly vouches for. */
  mods: string[]
  /** Its stars and notes, with whether the person reading starred it. */
  reactions: ReactionsView
}

/** A server's place in the directory, as its owner sees it. */
export interface OwnListingView {
  visibility: 'draft' | 'published' | 'unpublished'
  moderation: 'clear' | 'removed'
  moderationNote: string | null
  eligible: boolean
  reasons: Array<{ code: IneligibleCode; detail?: string }>
  /** In the directory right now. */
  visible: boolean
  /** The platform has paused the directory. */
  directoryPaused: boolean
}

export interface ReportView {
  id: string
  serverId: string
  serverName: string
  reason: string
  reporter: string
  createdAt: string
  moderation: 'clear' | 'removed'
}

export interface RemovedListingView {
  serverId: string
  name: string
  note: string | null
  removedAt: string
}

export interface TrustedProjectView {
  catalog: string
  projectId: string
  displayName: string
  addedBy: string
  note: string | null
  createdAt: string
}

export const BrowseInput = z.object({
  search: z.string().trim().max(100).default(''),
  tag: ServerTag.nullable().default(null),
  /** Only servers with someone on them right now. */
  onlineNow: z.boolean().default(false),
  /** Plain Minecraft, or servers running mods; either by default. */
  kind: z.enum(['any', 'vanilla', 'modded']).default('any'),
  offset: z.number().int().min(0).max(10_000).default(0),
})
export const ListingRef = z.object({ serverId: ServerId })
export const ReportListingInput = z.object({ serverId: ServerId, reason: z.string().trim().min(3).max(500) })
export const ModerateInput = z.object({
  serverId: ServerId,
  action: z.enum(['remove', 'restore']),
  note: z.string().trim().max(500),
})
export const ReportRef = z.object({ reportId: z.uuid() })
export const TrustProjectInput = z.object({
  projectId: z.string().trim().min(1).max(64),
  note: z.string().trim().max(300).optional(),
})
export const UntrustProjectInput = z.object({
  catalog: z.string().trim().min(1).max(40),
  projectId: z.string().trim().min(1).max(64),
})

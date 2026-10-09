import type { Lifecycle } from './lifecycle.ts'
import type { MemoryTier } from './size.ts'
import type { Slug } from './slug.ts'

/**
 * The aggregate root. It holds no hostname, no provider identifiers and no player counts:
 * those are derived (addressing), bound elsewhere (ServerRuntime) or live (presence).
 */
export interface MinecraftServer {
  id: string
  ownerId: string
  name: string
  /** What the owner says about it, wherever it is shared. */
  description: string
  /** One of Blockly's own icons, by key; null until the owner picks one. */
  icon: string | null
  /** Words from the directory's fixed set. */
  tags: readonly string[]
  slug: Slug
  /** The secret half of the invite link; whoever holds it may open the server's page. */
  inviteCode: string
  /** Desired placement, as a product region key. */
  regionKey: string
  /** Desired size. */
  memoryTier: MemoryTier
  lifecycle: Lifecycle
  desiredRevisionId: string
  activeWorldId: string
  /** Bumped on every write: optimistic concurrency and event ordering. */
  version: number
  createdAt: Date
  /**
   * When a server made for a while goes away. Blockly deletes it into the trash then, where its
   * world keeps its plan's retention; null for a server meant to last, and cleared the moment
   * its owner says to keep it.
   */
  expiresAt: Date | null
  /**
   * When someone last played on it, or its owner last started it. A world nobody has played for
   * as long as its plan says is stored away; a run a connection woke that nobody joined never
   * counts, so a stranger can't keep a world out of storage by knocking.
   */
  lastActiveAt: Date
  /** When its world was stored away; null while it has storage of its own. */
  storedAt: Date | null
  deletedAt: Date | null
  purgeAfter: Date | null
}

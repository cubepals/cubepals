import type { ModArtifact } from './artifact.ts'
import type { ReleaseRef } from './curation.ts'

/**
 * A modpack a server plays: a whole experience someone published, rather than mods Blockly put
 * together. Blockly pins the exact version, so a pack that updates never changes a world under
 * the people playing it; moving to a newer one is a change like any other.
 *
 * A pack brings its own Minecraft version, its own loader and its own configuration, which is
 * why a revision holds one *instead of* a mod list. What the pack contains is the pack's
 * business: Blockly doesn't take it apart, and never promises the mods inside it are vouched for.
 */
export interface PinnedModpack {
  /**
   * The catalog that published it, as a mod source names one; `upload` for a pack its owner
   * uploaded, which Blockly built into a pack of its own (docs/modpack-system.md); `blockly` for one
   * of Blockly's own packs (docs/modpack-templates.md § Blockly's own packs).
   */
  catalog: string
  /** The catalog's project; for an upload, the import it was built from; for Blockly's own, its key. */
  projectId: string
  /** The exact version, which is what makes a revision reproducible; for an upload, the built file's. */
  versionId: string
  /** What it is called, for everywhere a person reads about it. */
  name: string
  versionLabel: string
  /** The pack file itself; the image installs it, mods, configuration and all. */
  artifact: ModArtifact
  /** Where a player gets the same pack for their own game; null for an upload with no public page. */
  page: string | null
  /**
   * Whether everyone playing installs the pack too (`both`), or it runs on the server alone and
   * plain Minecraft joins (`server`): a pack made to speed up or run a server, rather than one
   * that changes what players see.
   */
  environment: 'server' | 'both'
  /** Its picture as the catalog shows it, so it is recognised at a glance; null when it has none. */
  icon: string | null
  /**
   * Paths of files the pack lists that only run in players' games, which the server leaves out.
   * A pack's own marks aren't enough (docs/modpack-system.md § Sides): Better MC 4 marks 63 mods
   * made for players' games as needed on the server. Absent on packs pinned before it existed.
   */
  leaveOut?: string[]
  /**
   * Paths of files the pack itself keeps off servers that a mod of it turned out to need, which
   * the server installs anyway: learned from a start, never pinned (docs/modpack-system.md § Verify).
   */
  forceInclude?: string[]
  /** `-D` properties the pack's author starts it with, which some mods read. */
  javaProperties?: Record<string, string>
  /**
   * The release of a pack Blockly offers by name that this is (`domain/mods/curation.ts`), when the
   * server was made from one. The bytes are pinned above either way; this says which reviewed
   * release they are, so the server is offered that pack's next release and nothing else.
   */
  curated?: ReleaseRef
  /**
   * The file its authors published, where the server installs Blockly's own copy instead (a
   * curated release Blockly may mirror): players always get the pack from its authors, never from
   * Blockly, so this is what their launchers are pointed at.
   */
  publishedFile?: string
}

/** Whether two revisions play the same pack at the same version. */
export const samePack = (a: PinnedModpack | null, b: PinnedModpack | null): boolean =>
  a === null || b === null ? a === b : a.catalog === b.catalog && a.versionId === b.versionId

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How checking a release ends: what it found, kept together once it is verified, or a refusal in
 * a sentence an admin acts on. Both checks (`catalog-check.ts`, `own-check.ts`) end in one of
 * these, and `ingest.ts` keeps it.
 *
 * It doesn't check anything or record anything: the checks decide, and ingestion writes what they
 * decided.
 */
import type { CuratedFactsJson } from '@blockly/db'
import type { Blocker } from '../../domain/mods/curation.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import type { PackContentsRecord } from '../packs/persistence.ts'
import { DownloadRefused, HostileArchive } from '../ports/formats.ts'

/** What checking one release found, kept together once it is verified. */
export interface Checked {
  distribution: 'mirror' | 'upstream'
  pack: PinnedModpack
  facts: CuratedFactsJson
  /** Blockly's own copy, where it keeps one. */
  stored: { sha512: string; key: string; sizeBytes: number } | null
  /** What that copy holds, by its own sha512. */
  contents: PackContentsRecord | null
  /** Files of the published pack only players' games read, which its servers leave out from now on. */
  forPlayers: string[]
}

/** What refuses a release: said in a sentence an admin acts on, with the detail kept behind it. */
export class Refused extends Error {
  readonly detail: string
  constructor(sentence: string, detail: string) {
    super(sentence)
    this.detail = detail
  }
}

/**
 * A download that went somewhere it may not go, or brought more than it should, as a refusal. A
 * host that doesn't answer is left to throw: the job tries again, and gives up into a refusal.
 */
export const refusedDownload =
  (what: string) =>
  (error: unknown): never => {
    if (error instanceof DownloadRefused)
      throw new Refused(`Fetching ${what} went somewhere Cubepals doesn’t fetch packs from.`, error.message)
    if (error instanceof HostileArchive)
      throw new Refused(`${what} is bigger than its authors say it is.`, error.message)
    throw error
  }

/** What stands in the way, as the sentence an admin reads on the release. */
export function blockedSentence(blockers: readonly Blocker[]): string {
  const named = (because: Blocker['because']) =>
    blockers.filter((blocker) => blocker.because === because).map((blocker) => blocker.name)
  const parts = [
    named('reserved').length > 0 ? `all rights reserved: ${named('reserved').join(', ')}` : null,
    named('noncommercial').length > 0 ? `noncommercial only: ${named('noncommercial').join(', ')}` : null,
    named('unread').length > 0 ? `licences nobody has read yet: ${named('unread').join(', ')}` : null,
  ].filter((part) => part !== null)
  return `Its licences don’t allow what the review asked for (${parts.join('; ')}).`
}

/**
 * The order a pack's releases come in, newest first: a reviewed pack's as its review lists them,
 * Blockly's own by the Minecraft each runs on.
 *
 * It doesn't say which of them is offered (`offering.ts`) or how they are shown (`admin-view.ts`).
 */
import { type OwnPack, ownGameVersion, ownOrder } from './own.ts'
import type { CuratedPack } from './packs.ts'
import type { CuratedReleaseRecord } from './persistence.ts'

/**
 * A pack's releases, newest first: a reviewed pack's in the review's order, Blockly's own by the
 * Minecraft each runs on, from those put together so far.
 */
export const orderOf = (pack: CuratedPack | OwnPack, releases: readonly CuratedReleaseRecord[]): string[] =>
  'releases' in pack
    ? pack.releases.map((spec) => spec.version)
    : ownOrder(
        releases
          .filter((record) => record.key === pack.key && ownGameVersion(record.version) !== null)
          .map((record) => record.version),
      )

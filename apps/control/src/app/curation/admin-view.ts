/**
 * The admins' page of curated packs: every reviewed pack, and each of its releases as checking
 * and the admins left it, whatever its state. It only reads.
 *
 * It doesn't decide who may see it: the service lets only admins ask. What people making a server
 * are offered is `offering.ts`.
 */
import type { CuratedPackAdminView, CuratedReleaseAdminView } from '@blockly/contracts'
import type { Db } from '@blockly/db'
import { LOADER_LABELS } from '../../minecraft/versions.ts'
import { orderOf } from './order.ts'
import type { OwnPack } from './own.ts'
import type { CuratedPack } from './packs.ts'
import { type CuratedReleaseRecord, loadReleases } from './persistence.ts'

/** Every reviewed pack and each of its releases as checking left it, for the admins' page. */
export async function reviewView(
  db: Db,
  packs: readonly CuratedPack[],
  own: readonly OwnPack[],
): Promise<CuratedPackAdminView[]> {
  const keys = [...own, ...packs].map((pack) => pack.key)
  const releases = await loadReleases(db, keys)
  return [...own, ...packs].map((pack) => {
    const theirs = releases.filter((record) => record.key === pack.key)
    return {
      key: pack.key,
      name: pack.name,
      authors: pack.authors,
      // Blockly's own packs copy nothing: every server fetches each mod from its authors.
      distribution: 'distribution' in pack ? pack.distribution : 'upstream',
      review: pack.review,
      held: ('held' in pack ? pack.held : undefined) ?? null,
      releases: orderOf(pack, theirs).flatMap((version) =>
        theirs.filter((record) => record.version === version).map(releaseAdminView),
      ),
    }
  })
}

/** A release as the admins' page shows it: where it stands, and what checking it found. */
function releaseAdminView(record: CuratedReleaseRecord): CuratedReleaseAdminView {
  const facts = record.facts
  const kinds: Record<string, number> = {}
  for (const entry of facts?.licences ?? []) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1
  return {
    version: record.version,
    state: record.state,
    distribution: record.distribution,
    refusal: record.refusal,
    detail: record.detail,
    withdrawnReason: record.withdrawnReason,
    changedBy: record.changedBy,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    publishedAt: record.publishedAt?.toISOString() ?? null,
    withdrawnAt: record.withdrawnAt?.toISOString() ?? null,
    facts:
      facts === null
        ? null
        : {
            gameVersion: facts.gameVersion,
            loaderLabel: LOADER_LABELS[facts.loader as keyof typeof LOADER_LABELS] ?? facts.loader,
            mods: facts.mods,
            checkedFiles: facts.checked.files,
            hosts: facts.checked.hosts,
            licences: kinds,
            mirrorBlockers: facts.mirrorBlockers.map((b) => `${b.name} (${b.licence ?? 'no licence'})`),
            code: facts.code,
          },
  }
}

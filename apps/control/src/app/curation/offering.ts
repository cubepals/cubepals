/**
 * What people making or updating a server are offered: the packs still in the review, each at a
 * release that was checked and that an admin published. It only reads.
 *
 * It doesn't publish or withdraw anything (`moves.ts`), and the admins' page, which shows every
 * release whatever its state, is `admin-view.ts`.
 */
import type { CuratedFactsJson, Db } from '@blockly/db'
import { newerRelease, offeredRelease } from '../../domain/mods/curation.ts'
import type { PinnedModpack } from '../../domain/mods/modpack.ts'
import { AppError, NotFound } from '../errors.ts'
import { orderOf } from './order.ts'
import { type OwnPack, ownPack } from './own.ts'
import { type CuratedPack, curatedPack } from './packs.ts'
import { loadPublished, loadRelease, loadReleases, type OfferableRecord } from './persistence.ts'

/** A verified release, with the pack a server of it pins and what checking it found. */
type CheckedRelease = OfferableRecord & { pack: PinnedModpack; facts: CuratedFactsJson }

/** A pack offered to people making a server, at the release they would get. */
export interface OfferedPack {
  pack: CuratedPack | OwnPack
  release: CheckedRelease
}

/**
 * The packs new servers are offered, in the review's order, each at its newest published
 * release. A pack no longer in the review isn't offered, whatever its releases say.
 */
export async function offered(
  db: Db,
  packs: readonly CuratedPack[],
  own: readonly OwnPack[],
): Promise<OfferedPack[]> {
  const keys = [...own, ...packs].map((pack) => pack.key)
  // Only a published release is ever offered, and each pack's order keeps the published ones in
  // the same order among themselves, so the rest needn't be read.
  const releases = await loadPublished(db, keys)
  return [...own, ...packs].flatMap((pack) => {
    const theirs = releases.filter((record) => record.key === pack.key)
    const release = offeredRelease(orderOf(pack, theirs), theirs)
    const checked = release === null ? null : checkedOf(release)
    return checked === null ? [] : [{ pack, release: checked }]
  })
}

/** The release a new server of a pack plays: the one asked for, which must be offered, or the newest. */
export async function releaseFor(
  db: Db,
  packs: readonly CuratedPack[],
  own: readonly OwnPack[],
  key: string,
  version?: string,
): Promise<OfferedPack> {
  const pack = curatedPack(key, packs) ?? ownPack(key, own)
  if (pack === null) throw new NotFound('Curated pack')
  if (version === undefined) {
    const found = (await offered(db, packs, own)).find((candidate) => candidate.pack.key === key)
    if (found === undefined) throw new AppError('invalid_choice', `${pack.name} isn’t offered right now.`)
    return found
  }
  const record = await loadRelease(db, key, version)
  const checked = record?.state === 'published' ? checkedOf(record) : null
  if (record === null || checked === null || !orderOf(pack, [record]).includes(version))
    throw new AppError('invalid_choice', `${pack.name} ${version} isn’t offered right now.`)
  return { pack, release: checked }
}

/**
 * The release a server that plays a curated pack is offered next: a published one newer than
 * its own in the review's order. Null for one that plays the newest, or no curated pack.
 */
export async function newerFor(
  db: Db,
  packs: readonly CuratedPack[],
  own: readonly OwnPack[],
  playing: PinnedModpack,
): Promise<OfferedPack | null> {
  const ref = playing.curated
  const pack = ref === undefined ? null : (curatedPack(ref.key, packs) ?? ownPack(ref.key, own))
  if (ref === undefined || pack === null) return null
  const releases = await loadReleases(db, [ref.key])
  const newer = newerRelease(orderOf(pack, releases), releases, ref.version)
  const checked = newer === null ? null : checkedOf(newer)
  return checked === null ? null : { pack, release: checked }
}

const checkedOf = (record: OfferableRecord): CheckedRelease | null =>
  record.pack === null || record.facts === null ? null : { ...record, pack: record.pack, facts: record.facts }

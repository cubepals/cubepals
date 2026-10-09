/**
 * An admin moving a reviewed release from one state to the next (docs/modpack-templates.md § A
 * release's life): offering it, withdrawing it, or asking for it to be checked again, each
 * guarded by the state it was read in and audited in the same transaction.
 *
 * It doesn't verify or refuse a release, which only checking does (`ingest.ts`), and it doesn't
 * queue the check an admin asks for again: the caller does that once the move is kept.
 */
import type { Db } from '@blockly/db'
import { nextState, type ReleaseEvent, type ReleaseRef, releaseRef } from '../../domain/mods/curation.ts'
import { type Actor, requestedBy } from '../actor.ts'
import { AppError, NotFound } from '../errors.ts'
import { audit } from './audit.ts'
import { type OwnPack, ownGameVersion, ownPack } from './own.ts'
import { type CuratedPack, curatedPack } from './packs.ts'
import { loadRelease, moveRelease } from './persistence.ts'

export async function move(
  deps: { db: Db; packs: readonly CuratedPack[]; own: readonly OwnPack[] },
  actor: Actor,
  release: ReleaseRef,
  event: ReleaseEvent,
  action: string,
  reason: string | null = null,
): Promise<void> {
  if (actor.kind !== 'admin') throw new NotFound('Curated pack')
  const pack = curatedPack(release.key, deps.packs)
  const own = ownPack(release.key, deps.own)
  const reviewed =
    pack !== null
      ? pack.releases.some((r) => r.version === release.version)
      : own !== null && ownGameVersion(release.version) !== null
  if (!reviewed) throw new NotFound('Release')
  // A hold is the review's to lift, never an admin's: publishing waits for the change that does.
  const held = (pack ?? own)?.held
  if (event === 'publish' && held !== undefined) throw new AppError('invalid_choice', held)
  await deps.db.transaction(async (tx) => {
    const record = await loadRelease(tx, release.key, release.version)
    if (record === null) throw new NotFound('Release')
    const to = nextState(record.state, event)
    if (to === null)
      throw new AppError('invalid_transition', `A release that is ${record.state} can’t be ${PAST[event]}.`)
    const moved = await moveRelease(tx, release.key, release.version, {
      from: record.state,
      to,
      by: requestedBy(actor),
      at: new Date(),
      withdrawnReason: reason,
    })
    if (!moved) throw new AppError('changed_meanwhile', 'Someone else changed this release. Look again.')
    await audit(tx, requestedBy(actor), action, releaseRef(release), {
      from: record.state,
      to,
      ...(reason === null ? {} : { reason }),
    })
  })
}

const PAST: Record<ReleaseEvent, string> = {
  verified: 'verified',
  refused: 'refused',
  publish: 'offered',
  withdraw: 'withdrawn',
  retry: 'checked again',
}

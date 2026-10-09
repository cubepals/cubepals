/**
 * Which reviewed releases are due to be checked: each one Blockly hasn't seen is recorded as
 * pending, and every pending one is queued for its check (docs/modpack-templates.md § Ingestion).
 *
 * It doesn't check anything (`ingest.ts` does, per job), and a refused release waits here for an
 * admin to ask again (`moves.ts`), never for the schedule.
 */
import type { Db } from '@blockly/db'
import { releaseRef } from '../../domain/mods/curation.ts'
import type { Loader } from '../../domain/revision/revision.ts'
import { offeredVersions, supports } from '../../minecraft/versions.ts'
import type { ModPlan } from '../mods/service.ts'
import type { JobQueue } from '../ports/jobs.ts'
import { type OwnPack, ownGameVersion, ownRelease } from './own.ts'
import type { CuratedPack } from './packs.ts'
import { insertPending, loadReleases } from './persistence.ts'

type Resolve = (
  target: { gameVersion: string; loader: Loader },
  wanted: ReadonlyArray<{ projectId: string }>,
) => Promise<ModPlan>

/**
 * `curation`: every reviewed release Blockly hasn't seen is recorded and queued to be checked, and
 * one still pending is queued again, in case its job was lost. Returns how many were queued.
 */
export async function queueDue(deps: {
  db: Db
  jobs: Pick<JobQueue, 'enqueueCuration'>
  /** Resolves a list of mods exactly as creating a server with them would. */
  resolve: Resolve
  packs: readonly CuratedPack[]
  own: readonly OwnPack[]
}): Promise<number> {
  const keys = [...deps.own, ...deps.packs].map((pack) => pack.key)
  const seen = new Map((await loadReleases(deps.db, keys)).map((record) => [releaseRef(record), record]))
  let queued = 0
  for (const pack of deps.packs)
    for (const spec of pack.releases) {
      const release = { key: pack.key, version: spec.version }
      const known = seen.get(releaseRef(release))
      if (known !== undefined && known.state !== 'pending') continue
      if (known === undefined) await insertPending(deps.db, release.key, release.version)
      await deps.jobs.enqueueCuration(release)
      queued++
    }
  for (const pack of deps.own) {
    const gameVersion = await newestRunning(deps.resolve, pack)
    if (gameVersion === null) continue
    // One release per Minecraft release: put together once, then kept as it was checked. One
    // still pending is queued again; a refused one waits for an admin to ask again.
    const known = [...seen.values()].find(
      (record) => record.key === pack.key && ownGameVersion(record.version) === gameVersion,
    )
    if (known !== undefined && known.state !== 'pending') continue
    const release = { key: pack.key, version: known?.version ?? ownRelease(new Date(), gameVersion) }
    if (known === undefined) await insertPending(deps.db, release.key, release.version)
    await deps.jobs.enqueueCuration(release)
    queued++
  }
  return queued
}

/**
 * The newest Minecraft Blockly offers on which every mod of one of its own packs runs, tried
 * release by release as creating a server with them would; null while none runs them all.
 */
async function newestRunning(resolve: Resolve, pack: OwnPack): Promise<string | null> {
  for (const { id } of offeredVersions()) {
    if (!supports(id, pack.loader)) continue
    const plan = await resolve({ gameVersion: id, loader: pack.loader }, pack.mods)
    if (plan.kind === 'ok') return id
  }
  return null
}

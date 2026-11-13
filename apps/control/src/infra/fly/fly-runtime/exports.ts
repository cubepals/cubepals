// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A snapshot's world packed into the archive store: a volume made from the snapshot, helper
 * machines that pack it and send it, and the volume deleted after. What the helpers run is
 * `helper-jobs.ts`, and taking a snapshot is `snapshots.ts`.
 */

import type { ArchiveTarget, PutPart, SnapshotHandle } from '../../../app/ports/runtime.ts'
import type { FlyClient } from '../client.ts'
import { decodeSnapshot } from '../handle.ts'
import { exportJob, PARTS_PER_JOB, partBatches, partsJob, partsPut } from './helper-jobs.ts'
import { helperJob } from './helper-machine.ts'
import { idOf } from './responses.ts'
import { type RoomWait, whenRoom } from './room.ts'
import { createVolume, deleteVolume, EXPORT_VOLUME_NAME, volumeReady } from './volumes.ts'

/**
 * The snapshot as a tar.gz, packed on a volume made from it by a helper machine, which sends it
 * in one PUT. One larger than a PUT carries waits on that volume while helpers send it in parts,
 * a few to each job.
 */
export async function exportSnapshot(
  fly: FlyClient,
  from: { deployment: string; roomWait: RoomWait },
  retentionDays: number,
  snapshot: SnapshotHandle,
  target: ArchiveTarget,
  signal?: AbortSignal,
): Promise<{ sizeBytes: number; sha256: string }> {
  const ref = decodeSnapshot(snapshot)
  // Twice the world's size: the archive is written beside the world before it is uploaded.
  const volume = await createVolume(
    fly,
    ref.app,
    {
      name: EXPORT_VOLUME_NAME,
      region: ref.region,
      size_gb: ref.sizeGb * 2,
      snapshot_id: ref.snapshotId,
    },
    retentionDays,
  )
  const volumeId = idOf(volume, 'a volume')
  const job = (script: string) =>
    whenRoom(from.roomWait, () =>
      helperJob(fly, from.deployment, ref.app, ref.region, volumeId, script, signal),
    )
  try {
    await volumeReady(fly, ref.app, volumeId)
    const [how = '', sha256 = '', size = '0'] = (await job(exportJob(target.put, target.maxPutBytes))).split(
      ' ',
    )
    const sizeBytes = Number(size)
    if (how === 'parts') {
      const parts = await target.inParts(sizeBytes, PARTS_PER_JOB)
      try {
        const put: PutPart[] = []
        for (const batch of partBatches(parts, sizeBytes, PARTS_PER_JOB))
          put.push(...partsPut(await job(partsJob(parts, sizeBytes, batch))))
        await parts.complete(put)
      } catch (error) {
        await parts.abort().catch(() => undefined)
        throw error
      }
    }
    return { sha256, sizeBytes }
  } finally {
    // The archive is up: a volume Fly won't let go of yet is the leftover sweep's.
    const sweep = `fly: ${ref.app} keeps export volume ${volumeId} for the leftover sweep`
    await deleteVolume(fly, ref.app, volumeId).catch((error: unknown) => console.warn(sweep, error))
  }
}

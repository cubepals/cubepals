/**
 * A Fly volume's snapshots: one taken and reported only once Fly has finished writing it, and
 * which of those taken Fly no longer holds. Fly can't delete one before it expires; how long they
 * are kept is set on the volume, in `volumes.ts`.
 */

import type { SnapshotHandle } from '../../../app/ports/runtime.ts'
import type { FlyClient } from '../client.ts'
import { decodeSnapshot, encodeSnapshot, isFlySnapshot } from '../handle.ts'
import { must, succeeded } from './responses.ts'
import { readVolume } from './volumes.ts'

/** When Fly says a snapshot it refuses to take again was scheduled: "already scheduled at <time>". */
function scheduledAt(error: unknown): number | null {
  const said = JSON.stringify(error ?? '').match(/already scheduled at ([0-9T:.-]+Z)/)?.[1]
  const at = said === undefined ? Number.NaN : Date.parse(said)
  return Number.isNaN(at) ? null : at
}

export async function takeSnapshot(fly: FlyClient, app: string, region: string, volumeId: string) {
  const before = new Set((await snapshotsOf(fly, app, volumeId)).map((s) => s.id))
  const taken = await fly.POST('/v1/apps/{app_name}/volumes/{volume_id}/snapshots', {
    params: { path: { app_name: app, volume_id: volumeId } },
  })
  // A snapshot asked for moments ago, by an attempt that failed after asking, is still being
  // taken: Fly refuses another and says when that one was scheduled. It is the one to use.
  const scheduled = taken.response.status === 412 ? scheduledAt(taken.error) : null
  if (scheduled === null) succeeded(taken, 'taking a snapshot')
  const ours = (s: { id?: string; created_at?: string }) =>
    s.id !== undefined &&
    (!before.has(s.id) || (scheduled !== null && Date.parse(s.created_at ?? '') >= scheduled))
  // Creating returns nothing; the new snapshot is the one that was not there before. It is
  // listed while Fly is still writing it, and only a finished one holds the world.
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const fresh = (await snapshotsOf(fly, app, volumeId))
      .filter(ours)
      .toSorted((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''))
      .at(-1)
    if (fresh?.status === 'failed') throw new Error('Fly could not take the snapshot')
    if (fresh?.id && (fresh.status === undefined || fresh.status === 'created')) {
      const volume = await readVolume(fly, app, volumeId)
      return {
        snapshot: encodeSnapshot({
          app,
          region,
          volumeId,
          snapshotId: fresh.id,
          sizeGb: volume?.size_gb ?? 1,
        }),
        sizeBytes: fresh.size ?? 0,
        at: new Date(fresh.created_at ?? Date.now()),
      }
    }
    await sleep(2000)
  }
  throw new Error('The snapshot did not finish')
}

/**
 * One listing per volume the snapshots were taken from, matched by Fly's snapshot id. A restore
 * or a move leaves a server on a new volume, and the old one's snapshots stay restorable until
 * they expire; a volume Fly won't list says nothing either way.
 */
export async function goneSnapshots(
  fly: FlyClient,
  snapshots: readonly SnapshotHandle[],
): Promise<ReadonlySet<SnapshotHandle>> {
  const byVolume = new Map<string, { app: string; volumeId: string; taken: Map<string, SnapshotHandle> }>()
  for (const snapshot of snapshots) {
    if (!isFlySnapshot(snapshot)) continue
    const ref = decodeSnapshot(snapshot)
    const volume = `${ref.app}/${ref.volumeId}`
    const group = byVolume.get(volume) ?? { app: ref.app, volumeId: ref.volumeId, taken: new Map() }
    group.taken.set(ref.snapshotId, snapshot)
    byVolume.set(volume, group)
  }
  const gone = new Set<SnapshotHandle>()
  for (const { app, volumeId, taken } of byVolume.values()) {
    const listed = await snapshotsOf(fly, app, volumeId).catch(() => null)
    if (listed === null) continue
    const held = new Set(listed.map((s) => s.id))
    for (const [id, snapshot] of taken) if (!held.has(id)) gone.add(snapshot)
  }
  return gone
}

async function snapshotsOf(fly: FlyClient, app: string, volumeId: string) {
  return must(
    await fly.GET('/v1/apps/{app_name}/volumes/{volume_id}/snapshots', {
      params: { path: { app_name: app, volume_id: volumeId } },
    }),
    'listing snapshots',
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

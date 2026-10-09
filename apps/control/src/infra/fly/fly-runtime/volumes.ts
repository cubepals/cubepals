/**
 * The Fly volumes a server's world lives on: found, made, grown, waited on while they hydrate,
 * and deleted. It never decides when a volume may go; the verbs in `fly-runtime.ts` order that
 * against the machines on it. Snapshots of a volume are `snapshots.ts`.
 */

import type { FlyClient, FlySchemas } from '../client.ts'
import { idOf, must, succeeded } from './responses.ts'

type Volume = FlySchemas['Volume']
type CreateVolumeRequest = FlySchemas['CreateVolumeRequest']

export const VOLUME_NAME = 'minecraft_data'
const VOLUME_GONE = new Set([
  'destroyed',
  'destroying',
  'pending_destroy',
  'scheduling_destroy',
  'waiting_for_detach',
])
const BOUND = /bound to machine/i
const UNBIND_SECONDS = 120

export async function ensureVolume(
  fly: FlyClient,
  app: string,
  region: string,
  sizeGb: number,
  retentionDays: number,
): Promise<Volume> {
  const existing = await dataVolume(fly, app)
  if (existing) {
    await fitVolume(fly, app, idOf(existing, 'a volume'), sizeGb, retentionDays)
    return existing
  }
  return createVolume(fly, app, { name: VOLUME_NAME, region, size_gb: sizeGb }, retentionDays)
}

/**
 * The app's world volume, if it has one that isn't going away. `deleted` names volumes a delete
 * already answered for: Fly's listing still calls one `created` for a moment after (staging,
 * 2026-10-08), and it must not read as a volume left behind.
 */
export async function dataVolume(
  fly: FlyClient,
  app: string,
  deleted: ReadonlySet<string> = new Set(),
): Promise<Volume | null> {
  const listed = await fly.GET('/v1/apps/{app_name}/volumes', { params: { path: { app_name: app } } })
  if (listed.response.status === 404) return null
  const live = (v: Volume) =>
    v.name === VOLUME_NAME && !VOLUME_GONE.has(v.state ?? '') && !deleted.has(v.id ?? '')
  return must(listed, 'listing volumes').find(live) ?? null
}

/**
 * A volume brought up to what its server needs now: grown to its size (volumes only grow), and
 * keeping snapshots as long as today's plans need them, which was set when it was made.
 */
export async function fitVolume(
  fly: FlyClient,
  app: string,
  volumeId: string,
  sizeGb: number,
  retentionDays: number,
): Promise<void> {
  const volume = await readVolume(fly, app, volumeId)
  if (volume === null) return
  if ((volume.size_gb ?? 0) < sizeGb)
    succeeded(
      await fly.PUT('/v1/apps/{app_name}/volumes/{volume_id}/extend', {
        params: { path: { app_name: app, volume_id: volumeId } },
        body: { size_gb: sizeGb },
      }),
      'growing the volume',
    )
  if (volume.snapshot_retention !== retentionDays)
    succeeded(
      await fly.PUT('/v1/apps/{app_name}/volumes/{volume_id}', {
        params: { path: { app_name: app, volume_id: volumeId } },
        body: { snapshot_retention: retentionDays },
      }),
      'setting how long snapshots are kept',
    )
}

/** Fly's own scheduled snapshots stay off: the product decides when backups happen. */
export async function createVolume(
  fly: FlyClient,
  app: string,
  body: CreateVolumeRequest,
  retentionDays: number,
): Promise<Volume> {
  return must(
    await fly.POST('/v1/apps/{app_name}/volumes', {
      params: { path: { app_name: app } },
      body: { auto_backup_enabled: false, snapshot_retention: retentionDays, ...body },
    }),
    'creating a volume',
  )
}

export async function readVolume(fly: FlyClient, app: string, volumeId: string): Promise<Volume | null> {
  const found = await fly.GET('/v1/apps/{app_name}/volumes/{volume_id}', {
    params: { path: { app_name: app, volume_id: volumeId } },
  })
  if (found.response.status === 404) return null
  return must(found, 'reading a volume')
}

/** A volume filled from a snapshot or a fork hydrates first. */
export async function volumeReady(fly: FlyClient, app: string, volumeId: string): Promise<void> {
  const deadline = Date.now() + 30 * 60_000
  while (Date.now() < deadline) {
    const volume = await readVolume(fly, app, volumeId)
    if (volume === null) throw new Error('The new volume disappeared')
    if (volume.state === 'created') return
    await sleep(2000)
  }
  throw new Error('The new volume did not become ready')
}

/**
 * Fly refuses to delete a volume still bound to a machine, as one is while Fly destroys the machine
 * in the background: 412, "volume is currently bound to machine". That is waited out, for two minutes.
 */
export async function deleteVolume(fly: FlyClient, app: string, volumeId: string): Promise<void> {
  const deadline = Date.now() + UNBIND_SECONDS * 1000
  for (;;) {
    const deleted = await fly.DELETE('/v1/apps/{app_name}/volumes/{volume_id}', {
      params: { path: { app_name: app, volume_id: volumeId } },
    })
    const bound = deleted.response.status === 412 && BOUND.test(JSON.stringify(deleted.error ?? ''))
    if (!bound || Date.now() > deadline) {
      succeeded(deleted, 'deleting a volume', 404)
      return
    }
    await sleep(1000)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

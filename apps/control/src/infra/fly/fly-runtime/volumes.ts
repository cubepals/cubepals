// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Fly volumes a server's world lives on: found, made, grown, waited on while they hydrate,
 * and deleted, as are the ones left beside a world that no machine mounts. It never decides when
 * a volume may go; the verbs in `fly-runtime.ts` order that against the machines on it.
 * Snapshots of a volume are `snapshots.ts`.
 */

import { MINUTE_MS } from '@blockly/contracts/durations'
import type { FlyClient, FlySchemas } from '../client.ts'
import { saysBound } from '../refusals.ts'
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
const UNBIND_SECONDS = 120

/**
 * The app's world volume, grown to `sizeGb`, or a new one. Known volumes come first: the one the
 * server's machine mounts, then the one its handle names (`held`). A rebuild that kept the old
 * storage leaves two world volumes in the app, and a volume it kept (`kept`) is never taken: it
 * holds the world as it was before the rebuild, and booting it would hide what was played since.
 * Where only kept storage is left, nothing is made either, which would boot no world at all: the
 * start fails, for an admin to decide.
 */
export async function ensureVolume(
  fly: FlyClient,
  app: string,
  region: string,
  sizeGb: number,
  retentionDays: number,
  known: { mounted?: string; held?: string | null; kept?: readonly string[] } = {},
): Promise<Volume> {
  const kept = new Set(known.kept ?? [])
  const existing =
    (await liveVolume(fly, app, known.mounted)) ??
    (await liveVolume(fly, app, known.held ?? undefined)) ??
    (await dataVolume(fly, app, kept))
  if (existing) {
    await fitVolume(fly, app, idOf(existing, 'a volume'), sizeGb, retentionDays)
    return existing
  }
  if (kept.size > 0 && (await dataVolume(fly, app)) !== null)
    throw new Error(`${app} holds only the storage kept from before a rebuild, which it doesn't boot`)
  return createVolume(fly, app, { name: VOLUME_NAME, region, size_gb: sizeGb }, retentionDays)
}

/** The volume, where it is there and not going away. */
async function liveVolume(fly: FlyClient, app: string, volumeId: string | undefined): Promise<Volume | null> {
  const volume = volumeId === undefined ? null : await readVolume(fly, app, volumeId)
  return volume !== null && !VOLUME_GONE.has(volume.state ?? '') ? volume : null
}

/**
 * The app's world volumes that aren't going away, as Fly lists them: one, but for a rebuild that
 * kept the old storage, or a restore that failed partway.
 */
export async function worldVolumes(fly: FlyClient, app: string): Promise<Volume[]> {
  const listed = await fly.GET('/v1/apps/{app_name}/volumes', { params: { path: { app_name: app } } })
  if (listed.response.status === 404) return []
  return must(listed, 'listing volumes').filter(
    (v) => v.name === VOLUME_NAME && !VOLUME_GONE.has(v.state ?? ''),
  )
}

/**
 * The app's world volume, if it has one that isn't going away, but none `skip` names: volumes a
 * delete already answered for, which Fly's listing still calls `created` for a moment after
 * (staging, 2026-10-08) and must not read as left behind, or volumes a rebuild kept.
 */
export async function dataVolume(
  fly: FlyClient,
  app: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<Volume | null> {
  return (await worldVolumes(fly, app)).find((v) => !skip.has(v.id ?? '')) ?? null
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
  const deadline = Date.now() + 30 * MINUTE_MS
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
    const bound = deleted.response.status === 412 && saysBound(deleted.error)
    if (!bound || Date.now() > deadline) {
      succeeded(deleted, 'deleting a volume', 404)
      return
    }
    await sleep(1000)
  }
}

/**
 * The app's world volumes that nothing uses, deleted: none in `keep`, not going already, and neither
 * mounted by a machine Fly lists nor attached to one. An attachment to a machine Fly no longer
 * lists counts for nothing: Fly went on claiming a wake's volume for a helper it had destroyed,
 * naming no machine (2026-10-10), and only a delete finds out whether it still does. What a wake,
 * a restore or a move that failed partway made, or a delete that gave up on. Each is asked once,
 * with no wait for Fly to let go: one it still holds stays for the next call. Export volumes are
 * left alone: an export makes one before any machine mounts it, and deletes its own. Returns the
 * ids deleted.
 */
export async function deleteLeftoverVolumes(
  fly: FlyClient,
  app: string,
  keep: readonly (string | null)[],
): Promise<string[]> {
  const listed = await fly.GET('/v1/apps/{app_name}/volumes', { params: { path: { app_name: app } } })
  if (listed.response.status === 404) return []
  const unused = must(listed, 'listing volumes').filter(
    (v) => v.name === VOLUME_NAME && !keep.includes(v.id ?? null) && !VOLUME_GONE.has(v.state ?? ''),
  )
  if (unused.length === 0) return []
  const machines = must(
    await fly.GET('/v1/apps/{app_name}/machines', { params: { path: { app_name: app } } }),
    'listing machines',
  ).filter((m) => m.state !== 'destroyed')
  const mounted = new Set(machines.flatMap((m) => (m.config?.mounts ?? []).map((mount) => mount.volume)))
  const listedIds = new Set(machines.flatMap((m) => (m.id ? [m.id] : [])))
  const deleted: string[] = []
  for (const volume of unused) {
    const volumeId = idOf(volume, 'a volume')
    if (mounted.has(volumeId) || listedIds.has(volume.attached_machine_id ?? '')) continue
    const answer = await fly.DELETE('/v1/apps/{app_name}/volumes/{volume_id}', {
      params: { path: { app_name: app, volume_id: volumeId } },
    })
    if (answer.response.ok || answer.response.status === 404) deleted.push(volumeId)
  }
  return deleted
}

/**
 * As a wake from the archive ends, world volumes an earlier wake that failed made, which Fly
 * wouldn't let go of then: one stayed, and the next wake made another beside it (2026-10-11).
 * Nothing else makes one in the app while the wake runs. One Fly still holds is the orphan sweep's,
 * and never fails the wake that worked.
 */
export async function clearEarlierWakes(fly: FlyClient, app: string, volumeId: string): Promise<void> {
  const deleted = await deleteLeftoverVolumes(fly, app, [volumeId]).catch((error: unknown) => {
    console.warn(
      `fly: clearing what earlier wakes left in ${app} failed; the orphan sweep tries again`,
      error,
    )
    return []
  })
  if (deleted.length > 0) console.warn(`fly: deleted ${deleted.join(', ')}, left beside ${app}'s world`)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

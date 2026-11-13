// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A new server's first volume made again where Fly put it on a host known to be slow. Fly picks a
 * volume's host as it makes the volume and names it at once (`zone`), its hosts in one region are
 * of several speeds, and the server's machine then runs on that host for as long as it keeps the
 * volume. So a volume on a host that earlier boots read as slow is replaced, while it is still
 * empty and before any machine is made on it, by one made beside it, which Fly places on another
 * host; then the first is deleted.
 *
 * Nothing is read or started here: what is known of a host comes from the boots that ran on it,
 * which the operation that provisions is asked for (`ProgressSink.slowHost`), and a host nothing is
 * known of is kept, to be read by the server's own boot. Only a volume `ensureProvisioned` made in the same call, for a server that held no storage,
 * comes here: never one that has held a world. Whatever fails leaves the server a volume to start
 * on, as it would have had.
 */

import type { ProgressSink } from '../../../app/ports/runtime.ts'
import type { FlyClient, FlySchemas } from '../client.ts'
import { hostOf } from './host-cpu.ts'
import { idOf } from './responses.ts'
import { createVolume, gameVolume } from './volumes.ts'

type Volume = FlySchemas['Volume']

/** How many times a new server's volume is made again; after that it keeps the host it has. */
const REMAKES = 3

/** What making a new server's volume again needs to know. */
interface NewVolume {
  /** The runtime's own id, under which hosts are known. */
  provider: string
  /**
   * Asked whether a host is known to be slow (`slowHost`; without it, none is), and told each
   * host left, for the operation's record (`slow_host:<region>/<zone>`).
   */
  progress: Pick<ProgressSink, 'slowHost' | 'mark'>
  /** The volume as the first was asked for: its region, its size, and the machine it is for. */
  region: string
  sizeGb: number
  memoryMb: number
  retentionDays: number
}

/**
 * The volume a new server starts on: `first`, or, where its host is known to be slow, another
 * made beside it, the one before it deleted; again for that one, `REMAKES` times at most. A host
 * Fly doesn't name, one nothing is known of, and one that can't be asked about are kept at once,
 * and so is every host where nobody answers which are slow.
 */
export async function offSlowHost(
  fly: FlyClient,
  app: string,
  first: Volume,
  how: NewVolume,
): Promise<Volume> {
  const { progress } = how
  let volume = first
  for (let times = 0; times < REMAKES; times++) {
    const host = hostOf(volume)
    const slow = host !== null && (await progress.slowHost?.(how.provider, host).catch(() => false))
    if (host === null || !slow) break
    const next = await another(fly, app, how)
    if (next === null) break
    const gone = await letGo(fly, app, idOf(volume, 'a volume'))
    volume = next
    await progress.mark?.(`slow_host:${host.region}/${host.id}`)
    // One volume left for the sweep is enough: a second remake could leave a second.
    if (!gone) break
  }
  return volume
}

/**
 * One more volume like the server's own, made while that one is still there, so Fly places it on
 * another host (`require_unique_zone`). Null where Fly makes none: the server keeps the one it has.
 */
async function another(fly: FlyClient, app: string, how: NewVolume): Promise<Volume | null> {
  try {
    const volume = await createVolume(
      fly,
      app,
      gameVolume(how.memoryMb, { region: how.region, size_gb: how.sizeGb, require_unique_zone: true }),
      how.retentionDays,
    )
    idOf(volume, 'a volume')
    return volume
  } catch (error) {
    console.warn(`fly: ${app} keeps its volume on a slow host, as no other could be made`, error)
    return null
  }
}

/**
 * A volume no machine has mounted, deleted: asked once, and never thrown for. Whether it went:
 * one Fly won't let go of now is logged, and is the leftover sweep's, as any world volume no
 * machine mounts and no handle names is (`deleteLeftoverVolumes`).
 */
async function letGo(fly: FlyClient, app: string, volumeId: string): Promise<boolean> {
  const left = (error: unknown) => {
    console.warn(`fly: ${app} still holds ${volumeId}; the leftover sweep tries again`, error)
    return false
  }
  const deleted = await fly
    .DELETE('/v1/apps/{app_name}/volumes/{volume_id}', {
      params: { path: { app_name: app, volume_id: volumeId } },
    })
    .catch(() => null)
  if (deleted === null) return left('the request failed')
  return deleted.response.ok || deleted.response.status === 404 || left(deleted.error)
}

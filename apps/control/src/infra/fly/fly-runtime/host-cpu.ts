// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The host a Fly machine runs on, read where Fly says it: its CPU from the machine's own
 * `/proc/cpuinfo`, since Fly's API says nothing of a host's hardware, and which host it is from
 * the `zone` of the volume the machine mounts, which Fly gives as it makes the volume. It only
 * reads: what a boot keeps of it is `app/operations/host-cpu.ts`'s.
 */

import { SECOND_MS } from '@blockly/contracts/durations'
import type { HostCpu } from '../../../app/ports/runtime.ts'
import type { FlyClient, FlySchemas } from '../client.ts'
import { exec, untilStarted } from './machines.ts'
import { readVolume } from './volumes.ts'

type Volume = FlySchemas['Volume']

/** What a machine reads its host's CPU from; the fake Fly answers the same command. */
export const CPUINFO = '/proc/cpuinfo'
/** How long a machine on its way up is waited for before its host goes unread. */
const STARTED_SECONDS = 20
const READ_SECONDS = 5

/**
 * The first processor `/proc/cpuinfo` lists: its `model name` and `cpu MHz`, either null where the
 * file has no such line, as on ARM; null where it has neither. In a guest the clock is the one its
 * host gave it as it started, the same at every read, and not a frequency that moves with load.
 */
export function parseCpuinfo(text: string): Pick<HostCpu, 'model' | 'mhz'> | null {
  const model = /^model name\s*:\s*(\S.*)$/m.exec(text)?.[1]?.trim() ?? null
  const clock = /^cpu MHz\s*:\s*(\d+(?:\.\d+)?)\s*$/m.exec(text)?.[1]
  const mhz = clock === undefined ? null : Number(clock)
  return model === null && mhz === null ? null : { model, mhz }
}

/** The host a volume is on, by Fly's names: its region, and its zone there; null where Fly gives none. */
function hostOf(volume: Volume | null): HostCpu['host'] {
  return volume?.region && volume.zone ? { region: volume.region, id: volume.zone } : null
}

/**
 * The host a machine runs on, once the machine is started: its CPU, and the zone of the volume it
 * mounts. Null where neither can be read. Throws where the machine doesn't start in time, is
 * gone, or Fly refuses the read.
 */
export async function readHostCpu(
  fly: FlyClient,
  app: string,
  machineId: string,
  volumeId: string | null,
): Promise<HostCpu | null> {
  await untilStarted(fly, app, machineId, AbortSignal.timeout(STARTED_SECONDS * SECOND_MS))
  const [read, volume] = await Promise.all([
    exec(fly, app, machineId, ['cat', CPUINFO], READ_SECONDS),
    volumeId === null ? null : readVolume(fly, app, volumeId).catch(() => null),
  ])
  const cpu = read.exitCode === 0 ? parseCpuinfo(read.stdout) : null
  const host = hostOf(volume)
  if (cpu === null && host === null) return null
  return { model: cpu?.model ?? null, mhz: cpu?.mhz ?? null, host }
}

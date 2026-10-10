// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Boat's sandbox sizes, by memory, disk and list price while running. It
 * neither makes nor resizes a sandbox; `sandboxes.ts` does, on the size `boat-runtime.ts` asks for.
 */

import type { RuntimePrices, RuntimeSpec } from '../../../app/ports/runtime.ts'
import { RuntimeUnsupported } from '../../../app/ports/runtime.ts'

export type SandboxType = 'small' | 'default' | 'large'

/** Boat's sizes, their memory, the disk a sandbox may keep, and their list price (docs.boat.dev/pricing). */
const TYPES: ReadonlyArray<{ type: SandboxType; memoryMb: number; dataGb: number; hourCents: number }> = [
  { type: 'small', memoryMb: 4096, dataGb: 12, hourCents: 1.8 },
  { type: 'default', memoryMb: 8192, dataGb: 50, hourCents: 3.6 },
  { type: 'large', memoryMb: 16384, dataGb: 125, hourCents: 7.2 },
]
/** What the VM needs beside the workload: the system, Docker and Boat's own agent (850 MB seen idle). */
const HEADROOM_MB = 1024
/** The image and the system on the disk beside the world. */
const IMAGE_GB = 2

/**
 * The smallest size whose memory holds the workload and the system, and whose disk holds the
 * world twice (itself and its snapshots) beside the image; null when none does. Today's largest
 * server, 8 GB with a 20 GB disk, fits `large`.
 */
export function typeFor(size: { memoryMb: number; storageGb: number }): SandboxType | null {
  const fits = TYPES.find(
    (t) => size.memoryMb + HEADROOM_MB <= t.memoryMb && size.storageGb * 2 + IMAGE_GB <= t.dataGb,
  )
  return fits?.type ?? null
}

/** The size a spec runs on. One no size holds is refused, never put on one too small for it. */
export function typeOf(spec: RuntimeSpec): SandboxType {
  const type = typeFor({ memoryMb: spec.resources.memoryMb, storageGb: spec.storage.sizeGb })
  if (type === null)
    throw new RuntimeUnsupported(
      'boat',
      `a server of ${spec.resources.memoryMb} MB with a ${spec.storage.sizeGb} GB disk, which no Boat size holds`,
    )
  return type
}

/** A size's price while it runs; a stopped sandbox's disk costs nothing. */
export function pricesFor(size: { memoryMb: number; storageGb: number }): RuntimePrices | null {
  const type = TYPES.find((t) => t.type === typeFor(size))
  return type === undefined ? null : { runningHourCents: type.hourCents, storageMonthCents: 0 }
}

/** What Boat keeps of the sandbox's data, by its type, less the image beside the world. */
export function snapshotRoomBytes(type: string | undefined): number {
  return ((TYPES.find((t) => t.type === type)?.dataGb ?? 12) - IMAGE_GB) * 2 ** 30
}

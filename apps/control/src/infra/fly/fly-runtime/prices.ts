// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prices a Fly server from Fly's list prices: an hour of running, by its CPUs and memory, and a
 * month of its volume. It decides nothing; which runtime is cheaper is `app/runtimes/economics.ts`.
 */

import type { RuntimeHandle, RuntimePrices } from '../../../app/ports/runtime.ts'
import { decodeHandle } from '../handle.ts'
import { guestFor } from '../machine-config.ts'

/** Fly's rates are dollars a second: an hour in cents is 360,000 of them. */
const HOUR_CENTS = 3600 * 100
/**
 * US cents, in iad, from Fly's list of 1 October 2026, which raised memory 20% and left CPU as it
 * was: a performance CPU is $0.000012732 a second with its 2 GB, memory past that $0.000002316 a
 * GB-second, and a volume $0.15 a GB a month (docs.fly.io/about/pricing). A 3 GB hour is $0.0542.
 */
const PRICES = {
  cpuHourCents: 0.000012732 * HOUR_CENTS,
  memoryGbHourCents: 0.000002316 * HOUR_CENTS,
  volumeGbMonthCents: 15,
}
const MB_WITH_A_CPU = 2048
/**
 * Regions that cost more than iad, by Fly's own factor for compute (docs.fly.io/about/pricing, as
 * corrected on 2026-09-25): fra's 3 GB hour is $0.0625.
 */
const REGION_PRICES: Readonly<Record<string, number>> = { fra: 1.153846154 }

/**
 * Fly's list prices of 1 October 2026 (`PRICES`): a performance CPU with its 2 GB, memory past
 * that, and a volume by the GB it holds, whether the machine runs or not. Snapshots and a
 * stopped machine's root filesystem cost a few cents more a month, and aren't counted.
 */
export function pricesOf(
  handle: RuntimeHandle,
  size: { memoryMb: number; storageGb: number },
): RuntimePrices {
  const guest = guestFor(size.memoryMb)
  const cpus = guest.cpus ?? 1
  const extraGb = Math.max(0, (guest.memory_mb ?? 0) - cpus * MB_WITH_A_CPU) / 1024
  const factor = REGION_PRICES[decodeHandle(handle).region] ?? 1
  return {
    runningHourCents: factor * (cpus * PRICES.cpuHourCents + extraGb * PRICES.memoryGbHourCents),
    storageMonthCents: size.storageGb * PRICES.volumeGbMonthCents,
  }
}

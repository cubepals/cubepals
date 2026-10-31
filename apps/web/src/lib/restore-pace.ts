// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How long bringing a backup back takes, by how big its world is, so the restore's countdown
 * (`presentProgress`) fits the world rather than reading "longer than usual" for one that is on
 * pace. Not the wait while an upload is read (`reading-pace.ts`), or while it goes up
 * (`upload-pace.ts`).
 *
 * Measured on production, one 2.1 GB uploaded world restored, 2026-10-31: keeping the world it
 * replaced took 101 s; fetching the 2.1 GB from the store 142 s, about 15 MB a second; setting
 * it up, starting Minecraft and loading the world 84 s. That pace agrees with a rested world's
 * wake on Fly, where a 1 GB world took 60 s longer than a new one (`unstore`).
 */

/** Keeping the world it replaces, which a restore always does first. */
const KEEPING_SECONDS = 100
/** Setting it up, starting Minecraft and loading the world, whatever its size. */
const STARTING_SECONDS = 85
/** Bytes a second a downloaded world is fetched from the store at, as production did. */
const FETCH_BYTES_PER_SECOND = 15 * 1024 ** 2

/**
 * The seconds a restore is expected to take. `worldBytes` is the size of a downloaded or uploaded
 * world it fetches; null for a snapshot, which the provider brings back itself and adds nothing
 * measured.
 */
export function restoreSeconds(worldBytes: number | null): number {
  const fetching = worldBytes === null ? 0 : worldBytes / FETCH_BYTES_PER_SECOND
  return Math.round(KEEPING_SECONDS + fetching + STARTING_SECONDS)
}

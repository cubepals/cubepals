// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How long reading a world that went up takes, said while it is read: the control plane fetches it
 * from the store, walks every file and keeps it again, at about the pace production read a 2.1 GB
 * world (4 minutes 16 seconds, about 8 MB a second). A countdown from that, which says so once it
 * runs long rather than stopping at nothing. Not how fast it went up (`upload-pace.ts`).
 */
import { SECOND_MS } from '@blockly/contracts/durations'
import { timeLeft } from './upload-pace'

/** Bytes a second the control plane reads an upload at, as production did. */
const READ_BYTES_PER_SECOND = 8 * 1024 ** 2
/** Every world takes a little time whatever its size: fetching it and keeping it again. */
const LEAST_SECONDS = 10

/** "About 3 minutes left", counted down from when reading began. */
export function readingLeft(sizeBytes: number, startedAt: number, now: number): string {
  const expected = Math.max(LEAST_SECONDS, sizeBytes / READ_BYTES_PER_SECOND)
  const left = expected - (now - startedAt) / SECOND_MS
  if (left > 0) return timeLeft(left)
  return left > -expected / 2 ? 'Almost there' : 'Taking longer than usual for a world this size'
}

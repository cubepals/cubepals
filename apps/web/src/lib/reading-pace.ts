// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** World-import progress from the worker's stage and byte counts; estimates apply only to that stage. */
import type { WorldImportProgress } from '@blockly/contracts'
import { MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import { bytes } from './present'
import { timeLeft } from './upload-pace'

const LABELS: Record<WorldImportProgress['step'], string> = {
  fetching: 'Fetching your uploaded world',
  checking: 'Checking the world’s files',
  players: 'Checking players and their inventories',
  mods: 'Finding the mods your server needs',
  packing: 'Preparing and saving your world',
  saving: 'Finishing and keeping your world safe',
}

/** Elapsed time, never a prediction of the remaining work. */
export function readingElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return whole < MINUTE_S ? `${whole}s` : `${Math.floor(whole / MINUTE_S)}m ${whole % MINUTE_S}s`
}

export function readingProgress(progress: WorldImportProgress | null, now: number) {
  if (progress === null)
    return {
      label: 'Waiting to prepare your world',
      detail: 'Your upload is safe. Waiting for a worker.',
      percent: null,
    }
  const elapsed = Math.max(0, now - Date.parse(progress.startedAt)) / SECOND_MS
  const parts = [`${readingElapsed(elapsed)} elapsed`]
  const total = progress.totalBytes
  if (total !== null) parts.unshift(`${bytes(progress.bytes)} of ${bytes(total)}`)
  const phaseAt = progress.steps.at(-1)?.at ?? progress.startedAt
  const measuredSeconds = (Date.parse(progress.updatedAt) - Date.parse(phaseAt)) / SECOND_MS
  const fresh = now - Date.parse(progress.updatedAt) < 15 * SECOND_MS
  if (total !== null && progress.bytes < total && progress.bytes > 0 && measuredSeconds >= 2 && fresh) {
    parts.push(`${timeLeft(((total - progress.bytes) / progress.bytes) * measuredSeconds)} in this step`)
  }
  return {
    label: LABELS[progress.step],
    detail: parts.join(' · '),
    // The bar describes this step. Completion is acknowledged only when the next stage arrives.
    percent: total === null || total <= 0 ? null : Math.min(99, Math.max(0, (progress.bytes / total) * 100)),
  }
}

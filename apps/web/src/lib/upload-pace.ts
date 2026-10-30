// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How an upload is going, in words a player reads under its bar: how much has gone, how fast, and
 * about how long is left. The speed is taken over the last few seconds, so a connection that slows
 * or speeds up moves the estimate, and the time left isn't guessed until there is enough to go on.
 * Not where the file is sent (`upload.ts`), or the bar drawn (`ui/upload-progress.tsx`).
 */
import { MINUTE_S, SECOND_MS } from '@blockly/contracts/durations'
import { bytes } from './present'

/** When, and how many bytes had gone by then. */
export interface Sample {
  at: number
  sent: number
}

/** The speed is the average over this long, so one slow second doesn't swing the estimate. */
const WINDOW_MS = 8 * SECOND_MS
/** Before this long, a speed is a guess, and the time left isn't said. */
const SETTLE_MS = 2 * SECOND_MS

/** The samples to keep once `next` arrives: those within the window, and the one just before it. */
export function keptSamples(samples: readonly Sample[], next: Sample): Sample[] {
  const kept = [...samples, next]
  const from = kept.findIndex((sample) => sample.at >= next.at - WINDOW_MS)
  return kept.slice(Math.max(0, from - 1))
}

/** Bytes a second over the samples, or null until they span long enough to say. */
export function speedOf(samples: readonly Sample[]): number | null {
  const first = samples[0]
  const last = samples.at(-1)
  if (first === undefined || last === undefined || last.at - first.at < SETTLE_MS) return null
  return ((last.sent - first.sent) / (last.at - first.at)) * SECOND_MS
}

/** The time left, said roughly: a countdown that jumps every second reads as noise. */
export function timeLeft(seconds: number): string {
  if (seconds < 10) return 'A few seconds left'
  if (seconds < MINUTE_S) return `About ${Math.ceil(seconds / 10) * 10} seconds left`
  const minutes = Math.round(seconds / MINUTE_S)
  if (minutes < 2) return 'About a minute left'
  if (minutes < 60) return `About ${minutes} minutes left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hourWord = hours === 1 ? '1 hour' : `${hours} hours`
  return rest === 0 ? `About ${hourWord} left` : `About ${hourWord} ${rest} min left`
}

/** The line under the bar: "120 MB of 320 MB · 4 MB/s · About 2 minutes left". */
export function paceLine(samples: readonly Sample[], total: number): string {
  const sent = samples.at(-1)?.sent ?? 0
  const parts = [`${bytes(sent) ?? '0 KB'} of ${bytes(total) ?? '0 KB'}`]
  const speed = speedOf(samples)
  if (sent >= total) parts.push('Finishing')
  else if (speed === null) parts.push('Working out the time left')
  else if (speed <= 0) parts.push('Waiting for the connection')
  else parts.push(`${bytes(speed)}/s`, timeLeft((total - sent) / speed))
  return parts.join(' · ')
}

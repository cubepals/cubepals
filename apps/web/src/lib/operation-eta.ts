// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** An honest countdown: it says so when the wait runs long instead of freezing at zero. */
export function etaLine(startedAt: string | null, expectedSeconds: number, now: number): string {
  const elapsed = startedAt ? (now - Date.parse(startedAt)) / 1000 : 0
  const left = Math.round(expectedSeconds - elapsed)
  if (left > 150) return 'A few minutes left'
  if (left > 90) return 'A couple of minutes left'
  if (left > 45) return 'About a minute left'
  if (left > 5) return `About ${Math.ceil(left / 5) * 5} seconds left`
  if (left > -30) return 'Almost there'
  return 'Taking a little longer than usual'
}

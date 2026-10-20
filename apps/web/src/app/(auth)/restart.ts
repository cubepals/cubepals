// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The second try after a provider's round trip lost its place: the state it came back with no
 * longer matched one this browser started. That happens without anyone refusing anything: Google
 * opened in another browser than the page (an app's own browser handing it on), two tabs started
 * one each, the trip took past the ten minutes the state lasts, or the callback loaded twice and
 * the browser kept the second answer. Starting again is safe, since the provider asks again, so
 * the page does it once, quietly. A second loss in a row shows the note.
 *
 * Remembered in the tab (sessionStorage): which provider this tab last went to, and whether that
 * trip was already the quiet second try. Not for anything about the account, which the control
 * plane keeps.
 */

/** The codes a round trip comes back with when it lost its place rather than being refused. */
export const INTERRUPTED: ReadonlySet<string> = new Set([
  'state_not_found',
  'state_mismatch',
  'please_restart_the_process',
  'invalid_code',
  'no_code',
])

/** The trip this tab last went on. */
export type Trip = { provider: string; again: boolean }

const STORED = 'cubepals:auth:trip'

/** The trip this tab last went on, or null when there was none or the tab keeps nothing. */
export function lastTrip(): Trip | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORED)
    return raw ? (JSON.parse(raw) as Trip) : null
  } catch {
    return null
  }
}

/** Remembers the trip about to start; false when the tab can't keep it. */
export function rememberTrip(trip: Trip): boolean {
  try {
    globalThis.sessionStorage.setItem(STORED, JSON.stringify(trip))
    return true
  } catch {
    return false
  }
}

/**
 * The provider to start again with, quietly, or null to show the note. Only after a lost place,
 * only once in a row, and only with a provider the page offers: the one the error page was marked
 * with (`?via=`), or else the one this tab last went to. A callback with no state Better Auth
 * still holds sends the browser to plain `/sign-in`, unmarked.
 */
export function restartWith(
  failure: string | null,
  via: string | null,
  last: Trip | null,
  offered: readonly string[],
): string | null {
  if (failure === null || !INTERRUPTED.has(failure) || last?.again) return null
  const provider = via ?? last?.provider ?? null
  return provider !== null && offered.includes(provider) ? provider : null
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the owner reads about the people who tried to join while their server rested for its
 * play: who, when, and that they were told. When it is back is said beside it (`OutForToday`).
 */
import type { ServerView } from '@blockly/contracts'
import { DAY_MS } from '@blockly/contracts/durations'

/** "Sam", "Sam and Alex", "Sam, Alex and 2 others". */
function who(names: readonly string[]): string {
  const [first, second] = names
  if (names.length === 1) return first ?? ''
  if (names.length === 2) return `${first} and ${second}`
  const rest = names.length - 2
  return `${first}, ${second} and ${rest} other${rest === 1 ? '' : 's'}`
}

/** "at 09:54", "yesterday at 09:54", "on 12 Oct at 09:54", in the owner's own time. */
function when(at: string, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const day = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)
  const days = Math.round((day(now) - day(date.getTime())) / DAY_MS)
  if (days === 0) return `at ${time}`
  if (days === 1) return `yesterday at ${time}`
  return `on ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`
}

/**
 * Who came by `server` while it rested, the latest try's time, and what they were told; null when
 * nobody did. `named` puts the server's name in, for a page about more than one server.
 */
export function cameByLine(
  server: Pick<ServerView, 'cameBy' | 'stopReason' | 'name'>,
  now: number,
  named = false,
): string | null {
  const [latest] = server.cameBy
  if (latest === undefined) return null
  const many = server.cameBy.length > 1
  const tried = `${who(server.cameBy.map((p) => p.name))} tried to join${named ? ` ${server.name}` : ''}`
  const at = `${many ? ', the last' : ''} ${when(latest.at, now)}`
  return server.stopReason === 'free_hours'
    ? `${tried}${at}, after your free trial’s hours were played. Cubepals told them it’s resting for now.`
    : `${tried}${at}, after today’s play was used up. Cubepals told them when it’s back.`
}

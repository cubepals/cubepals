// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the good-moment question says it noticed, so it reads as noticed and not as a form: the
 * friend who joined, the server that woke, the second week of play, and when.
 */
import type { MomentAskView } from '@blockly/contracts'

/** When it was, as a person says it: today, yesterday, a weekday this week, or a date. */
export function whenOf(at: Date, now: Date): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(at)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `on ${at.toLocaleDateString('en', { weekday: 'long' })}`
  return `on ${at.toLocaleDateString('en', { month: 'long', day: 'numeric' })}`
}

export function noticed(ask: MomentAskView, now = new Date()): string {
  const when = whenOf(new Date(ask.at), now)
  switch (ask.moment) {
    case 'moment_first_friend_joined':
      return `${ask.player ?? 'A friend'} joined ${ask.serverName} ${when}.`
    case 'moment_first_wake':
      return `${ask.serverName} woke for a player ${when}.`
    case 'moment_first_week':
      return `${ask.serverName} has had a second week of play.`
  }
}

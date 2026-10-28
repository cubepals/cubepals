// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How much is left of the free trial's hours, as the server's view gives them (`playTotal`), so
 * every number is the plan's own, and whether that is low enough to warn of: the mark the emails
 * that warn use too (`PLAY_WARNING_AT`). The server page and the list of servers both read it. Not
 * for a trial that is played: `outOfPlay` says that, and this has nothing then.
 */
import { PLAY_WARNING_AT, type ServerView } from '@blockly/contracts'

export type TrialLeft = {
  /** Hours left on this server's size, which a large one spends twice as fast. */
  hoursLeft: number
  /** At or past the mark: as much of it is used as the warning emails wait for. */
  low: boolean
}

/** What is left of the trial on `server`, or null where its plan has none or it is played. */
export function trialLeft(server: Pick<ServerView, 'playTotal'>): TrialLeft | null {
  const total = server.playTotal
  if (total === null || total.hoursLeft <= 0) return null
  const used = ((total.hours - total.hoursLeft) / total.hours) * 100
  return { hoursLeft: total.hoursLeft, low: used >= PLAY_WARNING_AT }
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { ServerView } from '@blockly/contracts'

/** Asleep in some way a join or the button would wake, but for its owner's play. */
const ASLEEP: readonly ServerView['status'][] = ['stopped', 'storing', 'stored']
/** Stops whose own words matter more, and that a join wouldn't wake anyway. */
const OWN_WORDS: readonly (ServerView['stopReason'] | null)[] = ['crash', 'policy', 'entitlement', 'unpaid']

/**
 * Whether its owner's play leaves the server resting, whatever put it to sleep: the free trial's
 * hours are all played (`trial`). Then nothing wakes it, not a join and not the button, and every
 * line on the page says so.
 */
export function outOfPlay(server: ServerView): 'trial' | null {
  if (!ASLEEP.includes(server.status)) return null
  if (server.status === 'stopped' && OWN_WORDS.includes(server.stopReason)) return null
  return server.playTotal && server.playTotal.hoursLeft <= 0 ? 'trial' : null
}

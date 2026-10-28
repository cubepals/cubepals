// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { hoursAndMinutes, type ServerView } from '@blockly/contracts'
import { trialLeft } from '../../lib/trial-left'
import { Note } from '../../ui'

/**
 * What is left of the free trial before the server rests (`trialLeft`): a quiet line on the
 * server's page, and a warning once it is low, which the list of servers shows too (`named`), so
 * an owner who never opens the page still sees it coming. Not for a trial that is played:
 * `FreeHoursUsed` says that.
 */
export function HoursLeft({ server, named = false }: { server: ServerView; named?: boolean }) {
  const left = trialLeft(server)
  if (left === null || (named && !left.low)) return null
  const hours = hoursAndMinutes(left.hoursLeft * 60)
  if (!left.low)
    return (
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        {hours} left of your free trial.
      </p>
    )
  // The list says it short, by the server's name; the page says what friends meet too.
  return (
    <Note tone="warning">
      {named
        ? `${hours} left of your free trial. Then ${server.name} rests.`
        : `${hours} left of your free trial. When it’s used, your server rests, and friends who come to join are told so.`}
    </Note>
  )
}

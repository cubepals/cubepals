// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { ServerView } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { useNow } from '../../lib/hooks'
import { Note, PlayerFace } from '../../ui'
import { cameByLine } from './came-by-line'

/**
 * The people who tried to join while the server rested for its owner's free trial, with their faces:
 * on the server's page, and on the list of servers for a page about more than one (`named`).
 * Gone once the server has run again.
 */
export function CameBy({ server, named = false }: { server: ServerView; named?: boolean }) {
  const now = useNow(MINUTE_MS)
  const line = cameByLine(server, now, named)
  if (line === null) return null
  return (
    <Note tone="info">
      <span className="bk-row" style={{ gap: 'var(--space-12)', alignItems: 'center' }}>
        <span className="bk-row" style={{ gap: 'var(--space-4)' }} aria-hidden>
          {server.cameBy.slice(0, 3).map((p) => (
            <PlayerFace key={p.uuid} name={p.name} uuid={p.uuid} size={24} />
          ))}
        </span>
        <span>{line}</span>
      </span>
    </Note>
  )
}

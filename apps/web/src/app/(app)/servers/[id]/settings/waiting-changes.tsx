// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What waits for everyone to leave a running server, where the owner chose to wait: each change,
 * and the two ways out of it, taking it now or keeping things as they are. Shown wherever the
 * server's changes are (`ChangeState`); nothing shows while nothing waits.
 */
import type { ServerView, WaitingChangesView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { presentChange } from '../../../../../lib/present'
import { Button, Note } from '../../../../../ui'
import { requestId } from '../use-server'
import { waitingLines } from './restart-lines'

/** The banner itself, given what waits and what each button does. */
export function WaitingNote({
  waiting,
  busy,
  error,
  onSettle,
}: {
  waiting: WaitingChangesView
  busy: boolean
  error: string | null
  onSettle: (settle: 'now' | 'cancel') => void
}) {
  const lines = waitingLines(waiting, presentChange)
  return (
    <Note tone="info">
      <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
        <span>
          {lines.length === 1 ? 'This change waits' : 'These changes wait'} until everyone has left, then the
          server restarts with {lines.length === 1 ? 'it' : 'them'}.
        </span>
        <ul
          className="bk-stack type-body-sm"
          style={{ gap: 'var(--space-4)', paddingLeft: 'var(--space-20)' }}
        >
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onSettle('now')}>
            Restart now
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onSettle('cancel')}>
            Cancel {lines.length === 1 ? 'this change' : 'these changes'}
          </Button>
        </div>
        {error !== null && <Note tone="danger">{error}</Note>}
      </div>
    </Note>
  )
}

export function WaitingChanges({ view, changed }: { view: ServerView; changed: (view: ServerView) => void }) {
  const trpc = useTRPC()
  const settle = useMutation(trpc.servers.settleWaiting.mutationOptions({ onSuccess: changed }))
  if (view.waiting === null) return null
  return (
    <WaitingNote
      waiting={view.waiting}
      busy={settle.isPending}
      error={settle.isError ? messageOf(settle.error) : null}
      onSettle={(how) => settle.mutate({ serverId: view.id, requestId: requestId(), settle: how })}
    />
  )
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The Players page's switches that restart a running server (Stop cheaters, the moderation tools,
 * the chat filter): with nobody on, a switch applies at once, as it always did; with someone
 * playing, it asks first, saying who is on and offering to wait for them to leave
 * (`settings/restart-choice.tsx`). Not for what each switch does, which is its own.
 */
import type { RestartWhen, ServerView } from '@blockly/contracts'
import { useState } from 'react'
import { occupied } from '../settings/restart-lines'
import { ConfirmChange } from '../settings/shared'

/** One switch's change, waiting for the owner to say when. */
interface Asked {
  title: string
  confirmLabel: string
  run: (when: RestartWhen) => Promise<unknown>
}

/**
 * `ask` runs a switch's change now where nobody would be dropped, and otherwise opens `dialog`,
 * which runs it once the owner has chosen when.
 */
export function useRestartAsk(view: Pick<ServerView, 'status' | 'players'>) {
  const [asked, setAsked] = useState<Asked | null>(null)
  const [error, setError] = useState<unknown>(null)
  const ask = (change: Asked) => {
    if (!occupied(view)) return void change.run('now').catch(() => undefined)
    setError(null)
    setAsked(change)
  }
  const dialog = (
    <ConfirmChange
      view={view}
      open={asked !== null}
      onClose={() => setAsked(null)}
      title={asked?.title ?? ''}
      confirmLabel={asked?.confirmLabel ?? ''}
      working="Saving your change"
      error={error}
      onConfirm={async (_requestId, when) => {
        try {
          await asked?.run(when)
          setAsked(null)
        } catch (failed) {
          setError(failed)
          throw failed
        }
      }}
    />
  )
  return { ask, dialog }
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When a change that restarts a running server lands, asked only while someone plays on it: who is
 * on, and the two choices, waiting for everyone to leave first. With nobody on it isn't asked, and
 * the change applies at once. The words are `restart-lines.ts`'s.
 */
import { RESTART_WHEN, type RestartWhen, type ServerView } from '@blockly/contracts'
import { Note } from '../../../../../ui'
import { onlineLine, WHEN_SAID } from './restart-lines'

export function RestartChoice({
  view,
  when,
  onChange,
}: {
  view: Pick<ServerView, 'status' | 'players'>
  when: RestartWhen
  onChange: (when: RestartWhen) => void
}) {
  const online = onlineLine(view)
  if (online === null) return null
  return (
    <Note tone="info">
      <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
        <span>{online} This change restarts the server.</span>
        <fieldset className="bk-chips">
          <legend className="bk-visually-hidden">When the server restarts</legend>
          {RESTART_WHEN.map((choice) => (
            <label key={choice} className="bk-chip">
              <input
                type="radio"
                name="restart-when"
                value={choice}
                checked={when === choice}
                onChange={() => onChange(choice)}
              />
              {WHEN_SAID[choice].label}
            </label>
          ))}
        </fieldset>
        <span className="type-body-sm">{WHEN_SAID[when].line}</span>
      </div>
    </Note>
  )
}

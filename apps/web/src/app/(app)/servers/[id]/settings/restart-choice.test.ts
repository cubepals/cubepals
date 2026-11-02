// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The choice of when a change restarts the server, and the note of what waits, as they draw. */
import { describe, expect, test } from 'bun:test'
import type { RestartWhen, ServerView } from '@blockly/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RestartChoice } from './restart-choice'
import { WaitingNote } from './waiting-changes'

const view = (online: number, status: ServerView['status'] = 'running') =>
  ({
    status,
    players: {
      online,
      people: ['Alex', 'Sam', 'Kim'].slice(0, online).map((name) => ({ name, uuid: name })),
    },
  }) as Pick<ServerView, 'status' | 'players'>

const choice = (online: number, when: RestartWhen = 'empty', status?: ServerView['status']) =>
  renderToStaticMarkup(createElement(RestartChoice, { view: view(online, status), when, onChange: () => {} }))

describe('choosing when a change restarts the server', () => {
  test('names who is on, and offers to wait for them, chosen first', () => {
    const html = choice(2)
    expect(html).toContain('Alex and Sam are online. This change restarts the server.')
    expect(html).toContain('When everyone leaves')
    expect(html).toContain('Restart now')
    expect(html).toMatch(/checked="" value="empty"/)
    expect(html).not.toMatch(/checked="" value="now"/)
    expect(html).toContain('Nobody is sent away.')
  })

  test('restarting now says the players get a countdown', () => {
    const html = choice(1, 'now')
    expect(html).toContain('Alex is online.')
    expect(html).toMatch(/checked="" value="now"/)
    expect(html).toContain('10-second countdown')
  })

  test('isn’t asked with nobody on, or a server that isn’t running', () => {
    expect(choice(0)).toBe('')
    expect(choice(2, 'empty', 'stopped')).toBe('')
  })
})

describe('what waits for everyone to leave', () => {
  const note = (waiting: Parameters<typeof WaitingNote>[0]['waiting'], error: string | null = null) =>
    renderToStaticMarkup(createElement(WaitingNote, { waiting, busy: false, error, onSettle: () => {} }))

  test('one change, worded as History words it, with both ways out', () => {
    const html = note({ changes: [{ field: 'pvp', from: true, to: false }], size: null, stopCheaters: null })
    expect(html).toContain('This change waits until everyone has left, then the server restarts with it.')
    expect(html).toContain('<li>PvP on → off</li>')
    expect(html).toContain('Restart now')
    expect(html).toContain('Cancel this change')
    expect(html).not.toContain('role="alert"')
  })

  test('several, with what went wrong', () => {
    const html = note({ changes: [], size: { from: '3 GB', to: '4 GB' }, stopCheaters: 'on' }, 'Try again.')
    expect(html).toContain('These changes wait until everyone has left, then the server restarts with them.')
    expect(html).toContain('<li>Size 3 GB → 4 GB</li>')
    expect(html).toContain('<li>Stop cheaters turns on</li>')
    expect(html).toContain('Cancel these changes')
    expect(html).toContain('Try again.')
  })
})

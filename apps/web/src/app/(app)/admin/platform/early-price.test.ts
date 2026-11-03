// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The early price on the platform page, as an admin reads it once its next setting is overdue. */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import type { PlatformControlsView } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiProvider } from '../../../../lib/api'
import { EarlyPrice } from './early-price'

const now = new Date('2026-10-01T12:00:00Z').getTime()
beforeAll(() => setSystemTime(new Date(now)))
afterAll(() => setSystemTime())

/** The section, with the room set an hour ago and due again a minute ago. */
const overdue = (closed: Partial<PlatformControlsView['earlyRoom']> = {}) =>
  renderToStaticMarkup(
    createElement(
      ApiProvider,
      null,
      createElement(EarlyPrice, {
        view: {
          earlyRoom: {
            roomPoints: 1200,
            points: { core: 100, plus: 300 },
            setAt: new Date(now - 60 * MINUTE_MS).toISOString(),
            validUntil: new Date(now - MINUTE_MS).toISOString(),
            closedSince: null,
            closedBy: null,
            holds: { count: 1, points: 100 },
            ...closed,
          },
        } as PlatformControlsView,
      }),
    ),
  )

describe('the early price once its next setting is overdue', () => {
  test('shows the room as last set, and says the setting is overdue', () => {
    const page = overdue()
    expect(page).toContain('next setting overdue since')
    expect(page).toContain('>1,200 points<')
  })

  test('closed by an admin, shows no room', () => {
    const page = overdue({ closedSince: new Date(now).toISOString(), closedBy: 'an admin' })
    expect(page).toContain('Closed by an admin')
    expect(page).toContain('>0 points<')
    expect(page).not.toContain('>1,200 points<')
  })
})

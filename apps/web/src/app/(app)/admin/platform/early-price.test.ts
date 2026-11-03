// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Admin checkout availability distinguishes a late refresh, manual closure, and no configured room. */
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test'
import type { PlatformControlsView } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiProvider } from '../../../../lib/api'
import { EarlyPrice } from './early-price'

const now = new Date('2026-10-01T12:00:00Z').getTime()
beforeAll(() => setSystemTime(new Date(now)))
afterAll(() => setSystemTime())

function drawn(changes: Partial<PlatformControlsView['earlyRoom']> = {}) {
  const view: PlatformControlsView = {
    provisioningEnabled: true,
    startsEnabled: true,
    publicListingEnabled: true,
    uploadsEnabled: true,
    storingEnabled: true,
    expiringEnabled: true,
    maxServers: 1,
    maxRunningServers: 1,
    maxFreeAccounts: 1,
    dailySpendLimitCents: 0,
    createsFull: null,
    updatedBy: null,
    updatedByEmail: null,
    updatedAt: new Date(now).toISOString(),
    usage: { servers: 0, running: 0 },
    signups: { freeAccounts: 0, waitlist: 0 },
    spend: null,
    catalogHeardAt: null,
    serverCeiling: null,
    playDomains: [],
    runtimeKeys: { version: 1, previousVersions: [], behind: 0 },
    earlyRoom: {
      roomPoints: 1200,
      points: { core: 100, plus: 300 },
      setAt: new Date(now - MINUTE_MS).toISOString(),
      validUntil: new Date(now + MINUTE_MS).toISOString(),
      closedSince: null,
      closedBy: null,
      holds: { count: 1, points: 100 },
      ...changes,
    },
  }
  return renderToStaticMarkup(
    // biome-ignore lint/correctness/noChildrenProp: createElement requires the provider's typed children prop
    createElement(ApiProvider, { children: createElement(EarlyPrice, { view }) }),
  )
}

test('a fresh refresh shows its due time and the configured room', () => {
  const page = drawn()
  expect(page).toContain('refresh due at')
  expect(page).toContain('>1,200 points<')
  expect(page).toContain('1, taking 100 points')
})

test('a refresh interruption keeps the available room visible and says it is overdue', () => {
  const page = drawn({ validUntil: new Date(now - MINUTE_MS).toISOString() })
  expect(page).toContain('refresh overdue since')
  expect(page).toContain('>1,200 points<')
  expect(page).not.toContain('ran out')
})

test('manual closure still shows no room during a refresh interruption', () => {
  const page = drawn({
    validUntil: new Date(now - MINUTE_MS).toISOString(),
    closedSince: new Date(now).toISOString(),
    closedBy: 'an admin',
  })
  expect(page).toContain('>0 points<')
  expect(page).toContain('Closed by an admin')
  expect(page).not.toContain('>1,200 points<')
})

test('an unconfigured room never invents checkout availability', () => {
  const page = drawn({ setAt: null, validUntil: null, holds: { count: 0, points: 0 } })
  expect(page).toContain('Never set.')
  expect(page).toContain('>0 points<')
  expect(page).toContain('None')
})

test('an incomplete refresh record does not advertise available room or a due time', () => {
  const page = drawn({ validUntil: null })
  expect(page).toContain('>0 points<')
  expect(page).not.toContain('refresh due at')
  expect(page).not.toContain('refresh overdue since')
})

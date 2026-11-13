// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a `connect` event of mc-router's says became of a join (`router-session.ts`). What a real
 * mc-router sends for each is in `router-drops.test.ts`.
 */
import { expect, test } from 'bun:test'
import { droppedFor, ROUTER_STATUS } from './router-session.ts'

test('a join mc-router connected was not dropped', () => {
  expect(
    droppedFor({ event: 'connect', status: ROUTER_STATUS.connected, backend: '127.0.0.1:25565' }),
  ).toBeNull()
})

test('a join it connected to nothing is refused, for the status it gave', () => {
  for (const status of [ROUTER_STATUS.missingBackend, ROUTER_STATUS.failedBackendConnection])
    expect(droppedFor({ event: 'connect', status })).toBe(`refused:${status}`)
})

test('a status it gains later is recorded as what it is, and an event with none says nothing', () => {
  expect(droppedFor({ event: 'connect', status: 'backend-full' })).toBe('refused:backend-full')
  expect(droppedFor({ event: 'connect' })).toBeNull()
})

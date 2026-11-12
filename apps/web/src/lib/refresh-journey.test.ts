// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the server page says of a start nobody waits for (`refresh-journey.ts`): one that shows
 * its owner's change, one that only keeps the server ready, and that neither reads as a wake.
 */
import { describe, expect, test } from 'bun:test'
import type { OperationView } from '@blockly/contracts'
import { presentProgress, wakeLine } from './present.ts'

const start = (refresh: boolean, keepsReady = false): OperationView =>
  ({
    id: 'op',
    kind: 'start',
    change: null,
    worldBytes: null,
    broughtWorld: null,
    ...(refresh ? { refresh: true } : {}),
    ...(keepsReady ? { keepsReady: true } : {}),
    status: 'running',
    step: 'booting',
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
  }) as OperationView

const server = { name: 'Island', gameVersion: '26.3', modCount: 0, modpack: null }

describe('a sleeping server started to show the icon or message its owner changed', () => {
  test('says it is showing the change, with a start’s steps and wait, never as a wake', () => {
    const plain = presentProgress(start(false), server as never)
    const refresh = presentProgress(start(true), server as never)
    expect(refresh?.title).toBe('Showing your changes in the server list')
    expect(refresh?.steps[0]?.label).toBe('Starting with your changes')
    expect(refresh?.steps.slice(1)).toEqual(plain?.steps.slice(1) ?? [])
    expect(refresh?.expectedSeconds).toBe(plain?.expectedSeconds ?? -1)
    expect(JSON.stringify(refresh)).not.toMatch(/wak/i)
    const line = wakeLine(
      { ...server, activeOperation: start(true), lastWakeSeconds: null } as never,
      Date.now(),
    )
    expect(line).toStartWith('Starting with your changes · ')
  })

  test('says a start that only keeps it ready as that, not as a change its owner never made', () => {
    const plain = presentProgress(start(false), server as never)
    const ready = presentProgress(start(true, true), server as never)
    expect(ready?.title).toBe('Keeping your server ready')
    expect(ready?.steps[0]?.label).toBe('Starting in the background')
    expect(ready?.steps.slice(1)).toEqual(plain?.steps.slice(1) ?? [])
    expect(JSON.stringify(ready)).not.toMatch(/wak|your changes/i)
  })

  test('leaves every other start as it was', () => {
    expect(presentProgress(start(false), server as never)?.title).toBe('Starting your server')
  })
})

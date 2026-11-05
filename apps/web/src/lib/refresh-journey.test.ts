// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { OperationView } from '@blockly/contracts'
import { presentProgress, wakeLine } from './present.ts'

const start = (refresh: boolean): OperationView =>
  ({
    id: 'op',
    kind: 'start',
    change: null,
    worldBytes: null,
    broughtWorld: null,
    ...(refresh ? { refresh: true } : {}),
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

  test('leaves every other start as it was', () => {
    expect(presentProgress(start(false), server as never)?.title).toBe('Starting your server')
  })
})

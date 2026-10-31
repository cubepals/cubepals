// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { OperationView } from '@blockly/contracts'
import { broughtJourney, broughtLanded } from './brought-journey.ts'
import { presentProgress } from './present.ts'

const restore = (broughtWorld: string | null): OperationView =>
  ({
    id: 'op',
    kind: 'restore',
    change: null,
    worldBytes: 2.1 * 1024 ** 3,
    broughtWorld,
    status: 'running',
    step: 'storage',
  }) as OperationView

describe('a world its owner brought, becoming the server’s world', () => {
  test('is spoken of by its name, never as a backup', () => {
    const progress = presentProgress(restore('Life'), { name: 'v0idworld' } as never)
    expect(progress?.title).toBe('Bringing Life to your server')
    expect(progress?.steps.map((step) => step.label)).toContain('Fetching Life')
    expect(JSON.stringify(progress)).not.toMatch(/backup|restor/i)
    expect(broughtLanded('Life')).toBe('Life is your server’s world now.')
  })

  test('leaves every other restore as it was', () => {
    expect(broughtJourney(restore(null))).toBeNull()
    expect(presentProgress(restore(null), { name: 'v0idworld' } as never)?.title).toBe(
      'Restoring your backup',
    )
  })
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { failureFix } from './failure-fix.ts'

describe('where a failure’s fix takes its owner', () => {
  test('a world from a newer Minecraft goes to the version, not to the backups', () => {
    expect(failureFix('s1', 'newer_minecraft', 'starting')).toEqual({
      label: 'Change its Minecraft',
      href: '/servers/s1/settings#version',
    })
  })

  test('each remedy with a page has its own', () => {
    expect(failureFix('s1', 'modpack', 'provisioning')?.href).toBe('/servers/new?replace=s1')
    expect(failureFix('s1', 'modpack', 'starting')?.label).toBe('Look at its modpack')
    expect(failureFix('s1', 'mods', 'starting')?.href).toBe('/servers/s1/mods')
    expect(failureFix('s1', 'restore', 'starting')?.href).toBe('/servers/s1/backups')
  })

  test('one with no page has no fix', () => {
    for (const remedy of ['ours', 'retry', 'more_room', null])
      expect(failureFix('s1', remedy, 'starting')).toBeNull()
  })
})

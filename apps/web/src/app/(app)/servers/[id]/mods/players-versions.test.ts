// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { ModView } from '@blockly/contracts'
import { playersVersions } from './players-versions'

const mod = (name: string, versionLabel: string): ModView => ({
  id: name.toLowerCase(),
  name,
  versionLabel,
  origin: 'user',
  requiredBy: [],
  environment: 'server',
  source: 'catalog',
  url: null,
  revoked: false,
  malware: false,
  datapack: false,
})
const update = (name: string, from: string, to: string, carried?: boolean) => ({
  from: mod(name, from),
  to: mod(name, to),
  ...(carried === undefined ? {} : { carried }),
})

describe('what an update’s confirmation says players need', () => {
  test('one a game can carry is named with its new version, whatever its authors mark it', () => {
    // VeinMiner 2.14.0 is marked for the server alone; a game that kept 2.13.0 is still cut off.
    expect(playersVersions([update('VeinMiner', '2.13.0', '2.14.0', true)])).toBe(
      'Players who have VeinMiner in their game need 2.14.0 to join. ',
    )
  })

  test('several are each named with theirs', () => {
    expect(
      playersVersions([
        update('VeinMiner', '2.13.0', '2.14.0', true),
        update('Terralith', '2.5.7', '2.5.8', false),
        update('Collective', '8.86', '8.87', true),
        update('Create', '6.0.9', '6.0.10', true),
      ]),
    ).toBe(
      'Players who have these in their game need the new versions to join: VeinMiner 2.14.0, Collective 8.87 and Create 6.0.10. ',
    )
  })

  test('nothing for an update no game carries, or an answer from before it was said', () => {
    expect(playersVersions([update('Terralith', '2.5.7', '2.5.8', false)])).toBe('')
    expect(playersVersions([update('VeinMiner', '2.13.0', '2.14.0')])).toBe('')
    expect(playersVersions([])).toBe('')
  })
})

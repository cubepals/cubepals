// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { SetupSourceInput } from '@blockly/contracts'
import { keptChoice, keptPath } from './kept'

const back = (path: string) => keptChoice(new URL(path, 'https://cubepals.test').searchParams)

describe('a choice carried through the address', () => {
  test('comes back as it left, whatever it was', () => {
    const choices: SetupSourceInput[] = [
      { kind: 'template', key: 'survival', gameVersion: '1.21.11' },
      { kind: 'curated', key: 'create' },
      { kind: 'modpack', projectId: 'abc' },
      { kind: 'import', importId: '0b6c0a6e-5d8e-4b3e-9a43-7d3c1f0c2b11' },
      // A world brought on its own page comes back to the create page chosen.
      { kind: 'world', importId: '8f2d8b51-3a7e-4d0c-b0c5-2b9a6d1e4f30' },
    ]
    for (const from of choices) expect(back(keptPath(from, '10', 'eu')).from).toEqual(from)
    expect(back(keptPath(null, null, null))).toEqual({ from: null, partySize: null, region: null })
  })
})

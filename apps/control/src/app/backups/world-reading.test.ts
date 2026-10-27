// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { accountNotes } from './world-reading.ts'

describe('what its owner reads of an offline-mode server’s players', () => {
  test('says how many were past the ones moved, whose files stay', () => {
    const notes = accountNotes({ renames: new Map(), matched: ['Alex'], unmatched: [], kept: [], beyond: 3 })
    expect(notes).toContain(
      'Cubepals moves the first 200 players of an offline-mode server to their accounts; the files of the 3 more stay as the server kept them.',
    )
  })
})

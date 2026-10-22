// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { RevisionSummary } from '../servers/revision-reads.ts'
import { summaryOf } from './queries.ts'

describe('a backup list reads revision summaries', () => {
  const summary: RevisionSummary = {
    id: 'r-1',
    number: 1,
    gameVersion: '1.21.4',
    loader: 'paper',
    modNames: [],
  }

  test('one that was found is returned', () => {
    expect(summaryOf(new Map([['r-1', summary]]), 'r-1')).toBe(summary)
  })

  test('one that is missing is an error naming it, as reading the whole revision was', () => {
    expect(() => summaryOf(new Map([['r-1', summary]]), 'r-2')).toThrow('Revision r-2 is missing')
  })
})

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { commitsOf, type PreviewCommit } from './preview-commits.ts'

test("a pull request's commits, newest first, and no other's", () => {
  const commit = (sha: string, pull: number, at: string): [string, PreviewCommit] => [
    sha.slice(0, 7),
    { sha, pull, at },
  ]
  const commits = new Map([
    commit('aaaaaaa1', 7, '2026-10-13T10:00:00.000Z'),
    commit('bbbbbbb1', 8, '2026-10-13T11:00:00.000Z'),
    commit('ccccccc1', 7, '2026-10-13T12:00:00.000Z'),
  ])
  expect(commitsOf(commits, 7).map((c) => c.sha)).toEqual(['ccccccc1', 'aaaaaaa1'])
  expect(commitsOf(commits, 9)).toEqual([])
})

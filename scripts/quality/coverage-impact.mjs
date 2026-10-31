// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Baseline comparisons for unchanged inputs. Verified additive tests and quality-only changes
 * cannot weaken earlier isolated tests. Dependency-only updates retain comparisons for the
 * source closures of tests that load an updated package. Every other change retains the full
 * baseline ratchet, and changed-source floors are always enforced by coverage.mjs.
 */
import { execFileSync } from 'node:child_process'
import { sourceFiles } from './inventory.mjs'
import { selectMutationScope } from './mutation-scope.mjs'

const identity = (entries) =>
  JSON.stringify(
    entries
      .filter((entry) => entry.kind !== 'infrastructure')
      .map(({ path, sha256, kind }) => ({ path, sha256, kind }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  )

export function baselineComparison(root, comparison, changed, currentInventory, baseInventory) {
  if (!/^[a-f0-9]{40}$/.test(comparison?.base ?? '') || !/^[a-f0-9]{40}$/.test(comparison?.head ?? ''))
    throw new Error('Coverage comparison requires authoritative base and head commits')
  const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  if (head !== comparison.head) throw new Error('Coverage comparison differs from the checked-out head')
  const scope = selectMutationScope({
    root,
    baseSha: comparison.base,
    headSha: comparison.head,
    productionFiles: sourceFiles(currentInventory),
    testFiles: currentInventory.filter((entry) => entry.kind === 'test').map((entry) => entry.path),
    changedFiles: changed,
  })
  if (identity(baseInventory) !== identity(scope.testImpact.baseInventory))
    throw new Error('Base coverage inventory differs from the authoritative base commit')
  if (scope.full) return null
  if (scope.baseScore)
    return { ...comparison, reason: 'dependency-only affected oracle closures', files: scope.subjects }
  if (scope.subjects.length === 0)
    return { ...comparison, reason: 'verified additive tests or quality-only inputs', files: [] }
  return null
}

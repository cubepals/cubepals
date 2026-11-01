// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** PRs mutate changed production files; full audits retain the complete source inventory. */
import { selectMutationScope } from './mutation-scope.mjs'

export function selectReleaseMutationScope(input) {
  // Keep authoritative Git/input validation and the complete dependent-test inventory.
  // Legacy test-impact expansion remains available independently to the coverage ratchet.
  const scope = selectMutationScope({ ...input, allowEmpty: true })
  if (input.full) return scope
  const production = new Set(input.productionFiles)
  const subjects = scope.changedFiles.filter((file) => production.has(file)).sort()
  const keep = (mapping) => Object.fromEntries(subjects.map((file) => [file, mapping[file]]))
  return {
    ...scope,
    subjects,
    testsByFile: keep(scope.testsByFile),
    additionalTestsByFile: keep(scope.additionalTestsByFile),
    full: false,
    baseScore: null,
    reasons: [
      'Release mutation scope is limited to new and changed production files; legacy audits run separately',
    ],
    noMutationReason: subjects.length
      ? null
      : 'No changed production files; functional tests and coverage checks still apply',
  }
}

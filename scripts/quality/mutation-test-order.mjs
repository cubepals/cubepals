// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Orders mutation tests using their verified, isolated execution counters. Importing a shared
 * harness is not evidence that a test exercises every service it constructs. This changes only
 * scheduling: every subject, candidate test, mutant and required score stays in the scope.
 */
import { groupOf } from './shards.mjs'

const metrics = ['functions', 'branches', 'statements']
const positive = (counts) => Object.values(counts).filter((value) => value > 0).length

function directoryDistance(source, test) {
  const left = source.split('/').slice(0, -1)
  const right = test.split('/').slice(0, -1)
  let common = 0
  while (common < Math.min(left.length, right.length) && left[common] === right[common]) common++
  return left.length + right.length - 2 * common
}

function ownsSubject(source, test) {
  const parts = source.split('/')
  const stem = parts.at(-1).replace(/\.[^.]+$/, '')
  const owner = stem === 'service' || stem === 'index' ? parts.at(-2) : stem
  const name = test
    .split('/')
    .at(-1)
    .replace(/\.test\.[^.]+$/, '')
  return (
    name === owner ||
    name.startsWith(`${owner}.`) ||
    name.startsWith(`${owner}-`) ||
    ((stem === 'service' || stem === 'index') &&
      test.split('/').slice(0, -1).join('/') === parts.slice(0, -1).join('/'))
  )
}

export function executionProfile(prepared, group) {
  return {
    version: 1,
    group,
    sources: Object.fromEntries(
      prepared.inventory.filter((entry) => entry.kind === 'source').map(({ path, sha256 }) => [path, sha256]),
    ),
    tests: Object.fromEntries(prepared.tests.map(({ path, sha256 }) => [path, { sha256, files: null }])),
  }
}

/** Called only after the fragment collector has validated each isolated test's counters. */
export function recordExecution(profile, fragments) {
  for (const fragment of fragments) {
    const into = profile.tests[fragment.test.path]
    if (!into || into.sha256 !== fragment.test.sha256 || into.files !== null)
      throw new Error('Unexpected or duplicate execution profile test')
    into.files = {}
    for (const [path, file] of Object.entries(fragment.files)) {
      const hit = {
        statements: positive(file.s),
        functions: positive(file.f),
        branches: Object.values(file.b).reduce(
          (sum, arms) => sum + arms.filter((value) => value > 0).length,
          0,
        ),
      }
      if (metrics.some((metric) => hit[metric] > 0)) into.files[path] = hit
    }
  }
}

function validateProfile(profile, entries, group) {
  if (
    profile?.version !== 1 ||
    profile.group !== group ||
    !profile.sources ||
    typeof profile.sources !== 'object' ||
    Array.isArray(profile.sources) ||
    !profile.tests ||
    typeof profile.tests !== 'object' ||
    Array.isArray(profile.tests)
  )
    throw new Error('Invalid mutation execution profile')
  const sources = new Map(
    entries.filter((entry) => entry.kind === 'source').map((entry) => [entry.path, entry.sha256]),
  )
  const tests = new Map(
    entries.filter((entry) => entry.kind === 'test').map((entry) => [entry.path, entry.sha256]),
  )
  if (sources.size !== Object.keys(profile.sources).length)
    throw new Error('Mutation execution profile source inventory differs')
  for (const [path, sha256] of Object.entries(profile.sources))
    if (sources.get(path) !== sha256) throw new Error(`Stale mutation execution source: ${path}`)
  if ([...tests].filter(([path]) => groupOf(path) === group).length !== Object.keys(profile.tests).length)
    throw new Error('Mutation execution profile test inventory differs')
  for (const [path, test] of Object.entries(profile.tests)) {
    if (
      tests.get(path) !== test.sha256 ||
      groupOf(path) !== group ||
      !test.files ||
      Array.isArray(test.files)
    )
      throw new Error(`Stale or incomplete mutation execution test: ${path}`)
    for (const [subject, hit] of Object.entries(test.files)) {
      if (!sources.has(subject) || !hit || Object.keys(hit).length !== metrics.length)
        throw new Error(`Invalid mutation execution counters: ${subject}`)
      for (const metric of metrics)
        if (!Number.isSafeInteger(hit[metric]) || hit[metric] < 0)
          throw new Error(`Invalid mutation execution counter: ${subject}: ${metric}`)
    }
  }
}

/** A profile may improve the first attempt, but cannot remove a static or ambiguous dependent. */
export function orderMutationTests(scope, profile, entries, group) {
  validateProfile(profile, entries, group)
  // Dependency comparisons deliberately use exactly the same complete oracle set on both sides.
  if (scope.baseScore) return scope
  const testsByFile = { ...scope.testsByFile }
  const additionalTestsByFile = { ...scope.additionalTestsByFile }
  for (const subject of scope.subjects) {
    const candidates = [...(testsByFile[subject] ?? []), ...(additionalTestsByFile[subject] ?? []).flat()]
    if (new Set(candidates).size !== candidates.length) throw new Error(`Duplicate mutation test: ${subject}`)
    const ordered = candidates.map((test, index) => {
      const execution = profile.tests[test]
      const hit = execution?.files[subject] ?? { functions: 0, branches: 0, statements: 0 }
      const reached = metrics.some((metric) => hit[metric] > 0)
      return { test, index, hit, rank: reached ? 0 : execution ? 2 : 1 }
    })
    if (!ordered.some((entry) => entry.rank === 0)) continue
    ordered.sort((a, b) => {
      // A focused suite in another shard has no counters in this profile. Its verified
      // static ownership still merits an early clean baseline, ahead of incidental imports.
      const priority = (entry) => (entry.rank !== 2 && ownsSubject(subject, entry.test) ? 0 : entry.rank + 1)
      const difference = priority(a) - priority(b)
      if (difference) return difference
      if (a.rank !== b.rank) return a.rank - b.rank
      const own = Number(ownsSubject(subject, b.test)) - Number(ownsSubject(subject, a.test))
      if (own) return own
      for (const metric of metrics) if (a.hit[metric] !== b.hit[metric]) return b.hit[metric] - a.hit[metric]
      return directoryDistance(subject, a.test) - directoryDistance(subject, b.test) || a.index - b.index
    })
    // Complementary domain suites belong in the same first attempt. Starting with just one
    // can spend the budget proving a partial score before unrelated integration suites expand.
    const owners = ordered.filter((entry) => entry.rank === 0 && ownsSubject(subject, entry.test))
    const first = owners.length > 1 ? owners.slice(0, 4) : ordered.slice(0, 1)
    testsByFile[subject] = first.map((entry) => entry.test)
    const selected = new Set(testsByFile[subject])
    const remaining = ordered.filter((entry) => !selected.has(entry.test))
    const batches = []
    let batch = []
    let rank = remaining[0]?.rank
    for (const entry of remaining) {
      if (batch.length === 4 || entry.rank !== rank) {
        if (batch.length) batches.push(batch)
        batch = []
      }
      batch.push(entry.test)
      rank = entry.rank
    }
    if (batch.length) batches.push(batch)
    additionalTestsByFile[subject] = batches
  }
  return { ...scope, testsByFile, additionalTestsByFile }
}

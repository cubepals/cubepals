// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selects mutation subjects from source changes and the dependencies of changed tests. Imports
 * are parsed, including re-exports and literal dynamic imports; ambiguous local loading falls
 * back to the complete inventory. Existing-test edits retain base and head dependencies; verified
 * newly added test files do not, by themselves, certify or mutate every unchanged legacy import.
 */
import { createHash } from 'node:crypto'
import { oracleTests } from './dependency-impact.mjs'
import { inventory } from './inventory.mjs'
import { dependencyGraph } from './mutation-dependencies.mjs'
import { analyzeTestImpact } from './test-impact.mjs'

export { dependencyGraph }

/** Seven disjoint stable partitions visit the complete source inventory over a scheduled week. */
export function rotationSubjects(subjects, rotation) {
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 6)
    throw new Error('Rotation must be an integer from 0 to 6')
  return subjects.filter(
    (subject) => createHash('sha256').update(subject).digest().readUInt32BE(0) % 7 === rotation,
  )
}

function closure(graph, start) {
  const seen = new Set()
  const pending = [start]
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    pending.push(...(graph.get(file) ?? []))
  }
  return seen
}

export function selectMutationScope({
  root,
  productionFiles,
  testFiles,
  changedFiles,
  full = false,
  ignoredConfigFiles = new Set(),
  baseSha,
  headSha = 'HEAD',
}) {
  if (full && productionFiles.length === 0) throw new Error('Full mutation inventory is empty')
  const impact = baseSha ? analyzeTestImpact({ root, baseSha, headSha, changedFiles }) : null
  if (impact) {
    if (!sameFiles(productionFiles, impact.headSourceFiles) || !sameFiles(testFiles, impact.headTestFiles))
      throw new Error('Supplied mutation inventory differs from the inspected Git head')
    changedFiles = impact.verifiedChangedFiles
    ignoredConfigFiles = new Set([
      ...impact.verifiedQualityOnlyConfigs,
      ...(impact.dependencyOnly.eligible ? impact.dependencyOnly.files : []),
    ])
  }
  const addedTests = impact?.verifiedAddedTests ?? new Set()
  const source = new Set(productionFiles)
  const tests = new Set(testFiles)
  const changed = new Set(changedFiles)
  const { graph, ambiguous } = dependencyGraph(root, [...source, ...tests])
  const reverse = reverseDependencies(graph)
  const testDependencies = new Map(testFiles.map((file) => [file, closure(graph, file)]))
  const reasons = [...(impact?.reasons ?? [])]
  if (full) reasons.push('full inventory requested')
  if (impact?.baseFull) full = true
  if (addedTests.size)
    reasons.push(
      `${addedTests.size} new test files verified against Git; additions alone do not expand incremental mutation scope`,
    )
  if (
    changedFiles.some(
      (file) =>
        !file.startsWith('tools/quality/') &&
        !ignoredConfigFiles.has(file) &&
        /(?:^|\/)(?:package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json)$/.test(file),
    )
  ) {
    full = true
    reasons.push('dependency or resolution configuration changed')
  }
  const subjects = new Set([
    ...changedFiles.filter((file) => source.has(file)),
    ...[...(impact?.baseRequiredSubjects ?? [])].filter((file) => source.has(file)),
  ])
  for (const file of changedFiles) {
    if (tests.has(file) && !addedTests.has(file)) {
      for (const dependency of testDependencies.get(file) ?? []) {
        if (source.has(dependency)) subjects.add(dependency)
      }
    }
    if (
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !tests.has(file) &&
      !impact?.mappedRemovedTests?.has(file) &&
      !file.startsWith('scripts/quality/') &&
      !file.startsWith('tools/quality/')
    ) {
      full = true
      reasons.push(`test removed: ${file}`)
    }
  }
  for (const file of [
    ...subjects,
    ...changedFiles.filter((path) => tests.has(path) && !addedTests.has(path)),
  ]) {
    if ([...closure(graph, file)].some((dependency) => ambiguous.has(dependency))) {
      full = true
      reasons.push(`ambiguous dependency mapping: ${file}`)
    }
  }
  const dependencyOnly = impact?.dependencyOnly?.eligible && !full ? impact.dependencyOnly : null
  let oracles = new Map()
  if (dependencyOnly) {
    oracles = oracleTests(root, inventory(root), dependencyOnly.affectedPackages)
    for (const closure of oracles.values()) for (const file of closure) subjects.add(file)
    reasons.push(
      `dependency-only update (${dependencyOnly.changedPackages.length} lock records); ${oracles.size} tests load an updated package and are held to their base mutation scores`,
    )
  }
  if (full) {
    if (source.size === 0) throw new Error('Full mutation inventory is empty')
    for (const file of source) subjects.add(file)
  }
  if (subjects.size === 0 && changedFiles.some((file) => tests.has(file) && !addedTests.has(file))) {
    throw new Error('Changed tests have no mutation subjects; refusing an empty mutation run')
  }
  const testsByFile = {}
  const additionalTestsByFile = {}
  for (const file of [...subjects].sort()) {
    const distances = dependencyDistances(reverse, file)
    const dependents = testFiles.filter((test) => {
      const dependencies = testDependencies.get(test)
      return dependencies.has(file) || [...dependencies].some((dependency) => ambiguous.has(dependency))
    })
    const proven = dependents.filter((test) => testDependencies.get(test).has(file))
    const smallest = Math.min(
      ...(proven.length ? proven : dependents).map((test) => testDependencies.get(test).size),
    )
    const ordered = dependents
      .map((test) => {
        const footprint = testDependencies.get(test).size
        return {
          test,
          footprint,
          uncertain: testDependencies.get(test).has(file) ? 0 : 1,
          tier: Math.max(0, Math.floor(Math.log2(footprint / smallest))),
          distance: distances.get(test) ?? Number.POSITIVE_INFINITY,
        }
      })
      .sort(
        (a, b) =>
          a.uncertain - b.uncertain ||
          a.tier - b.tier ||
          a.distance - b.distance ||
          a.footprint - b.footprint ||
          a.test.localeCompare(b.test),
      )
    // Footprint and import distance schedule work; they never exclude source, tests or mutants.
    // A small unchanged unit suite can already prove the complete per-file threshold. Keep
    // expensive changed or direct integration tests for expansion when that proof is insufficient.
    // Possible dynamic dependents follow statically proved dependents rather than displacing them.
    const first = ordered[0]
    testsByFile[file] = ordered
      .filter(
        (entry) =>
          entry.uncertain === first.uncertain &&
          entry.tier === first.tier &&
          entry.distance === first.distance,
      )
      .slice(0, 4)
      .map(({ test }) => test)
    const selected = new Set(testsByFile[file])
    const additional = ordered.filter(({ test }) => !selected.has(test))
    additionalTestsByFile[file] = []
    let batch = []
    let previous
    for (const entry of additional) {
      // Never drag a large harness into the same attempt as the last inexpensive unit tests.
      if (
        batch.length === 4 ||
        (previous && (entry.tier !== previous.tier || entry.uncertain !== previous.uncertain))
      ) {
        additionalTestsByFile[file].push(batch)
        batch = []
      }
      batch.push(entry.test)
      previous = entry
    }
    if (batch.length) additionalTestsByFile[file].push(batch)
  }
  if (dependencyOnly) {
    // Base and head run exactly the tests whose oracle may have changed, with no expansion,
    // so the two scores measure the same tests against the same mutants.
    for (const file of subjects) {
      testsByFile[file] = [...oracles].filter(([, closure]) => closure.includes(file)).map(([test]) => test)
      additionalTestsByFile[file] = []
    }
  }
  return {
    subjects: [...subjects].sort(),
    testsByFile,
    additionalTestsByFile,
    full,
    reasons,
    changedFiles: [...changed],
    testImpact: impact?.evidence ?? null,
    baseScore: dependencyOnly ? { subjects: [...subjects].sort(), oracleTests: [...oracles.keys()] } : null,
    noMutationReason: subjects.size
      ? null
      : dependencyOnly
        ? 'Dependency-only update: source and tests are unchanged and no test loads an updated package; the complete suite and the coverage ratchet judge it'
        : addedTests.size
          ? 'Verified new test additions with no production or existing-test mutation obligations; standalone new test strength is not certified'
          : 'No executable source or existing test changes require incremental mutation',
  }
}

function sameFiles(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  )
}

function reverseDependencies(graph) {
  const reverse = new Map()
  for (const [file, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!reverse.has(dependency)) reverse.set(dependency, new Set())
      reverse.get(dependency).add(file)
    }
  }
  return reverse
}

function dependencyDistances(reverse, start) {
  const distances = new Map([[start, 0]])
  const pending = [start]
  for (let index = 0; index < pending.length; index++) {
    const file = pending[index]
    for (const importer of reverse.get(file) ?? []) {
      if (distances.has(importer)) continue
      distances.set(importer, distances.get(file) + 1)
      pending.push(importer)
    }
  }
  return distances
}

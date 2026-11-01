// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CI entrypoint: one exhaustive source partition, with incremental test-aware subject selection.
 * A dependency-only update measures its subjects on the base worktree (`--base-root`, installed
 * from the base lockfile) and holds the head to those scores.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { inventory, sourceFiles } from './inventory.mjs'
import { runMutation } from './mutation.mjs'
import { rotationSubjects, selectMutationScope } from './mutation-scope.mjs'
import { orderMutationTests } from './mutation-test-order.mjs'
import { groupOf, groups } from './shards.mjs'

const { values } = parseArgs({
  options: {
    changed: { type: 'string' },
    comparison: { type: 'string' },
    base: { type: 'string' },
    head: { type: 'string' },
    group: { type: 'string' },
    full: { type: 'boolean', default: false },
    rotation: { type: 'string' },
    output: { type: 'string' },
    root: { type: 'string', default: process.cwd() },
    'base-root': { type: 'string' },
  },
})
if (
  !values.group ||
  !Object.hasOwn(groups, values.group) ||
  !values.output ||
  (!values.changed && !values.full)
) {
  throw new Error(
    'Usage: mutation-cli.mjs --changed PATH --base SHA --head SHA --group GROUP --output DIR [--full] [--root DIR]',
  )
}
if (values.rotation !== undefined && (!values.full || !/^[0-6]$/.test(values.rotation)))
  throw new Error('--rotation must be 0 through 6 and requires --full')
const anchored = !values.full || values.base !== undefined || values.head !== undefined
if (anchored && (!/^[a-f0-9]{40}$/.test(values.base ?? '') || !/^[a-f0-9]{40}$/.test(values.head ?? '')))
  throw new Error('Incremental mutation requires authoritative --base and --head commit SHAs')
const root = resolve(values.root)
const output = resolve(values.output)
const changed = values.changed ? JSON.parse(readFileSync(resolve(values.changed), 'utf8')) : []
if (!Array.isArray(changed) || changed.some((file) => typeof file !== 'string'))
  throw new Error('Changed files must be a JSON string array')
const comparisonPath = values.comparison
  ? resolve(values.comparison)
  : values.changed
    ? resolve(dirname(resolve(values.changed)), 'comparison.json')
    : null
if (anchored) {
  if (!comparisonPath || !existsSync(comparisonPath))
    throw new Error('Missing comparison evidence for the authoritative base and head')
  const comparison = JSON.parse(readFileSync(comparisonPath, 'utf8'))
  if (comparison?.base !== values.base || comparison?.head !== values.head)
    throw new Error('Comparison evidence differs from the authoritative --base or --head')
  const checkout = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  if (checkout !== values.head) throw new Error('The checkout does not match the authoritative --head')
}
const entries = inventory(root)
let scope = selectMutationScope({
  root,
  productionFiles: sourceFiles(entries),
  testFiles: entries.filter((entry) => entry.kind === 'test').map((entry) => entry.path),
  changedFiles: changed,
  full: values.full,
  baseSha: anchored ? values.base : undefined,
  headSha: anchored ? values.head : 'HEAD',
})
const executionPath = values.changed
  ? join(dirname(resolve(values.changed)), 'head', 'test-execution', `${values.group}.json`)
  : null
if (executionPath && existsSync(executionPath)) {
  const bytes = readFileSync(executionPath)
  scope = orderMutationTests(scope, JSON.parse(bytes), entries, values.group)
  scope.testOrdering = {
    kind: 'isolated-execution',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
const groupSubjects = scope.subjects.filter((subject) => groupOf(subject) === values.group)
const rotation = values.rotation === undefined ? null : Number(values.rotation)
const subjects = rotation === null ? groupSubjects : rotationSubjects(groupSubjects, rotation)
const selection = {
  group: values.group,
  rotation,
  rotations: rotation === null ? null : 7,
  totalInGroup: groupSubjects.length,
  selectedCount: subjects.length,
}
mkdirSync(output, { recursive: true })
writeFileSync(
  resolve(output, 'scope.json'),
  JSON.stringify(
    {
      ...scope,
      ...selection,
      selected: subjects,
      verifiedQualityOnlyConfigs: scope.testImpact?.verifiedQualityOnlyConfigs ?? [],
    },
    null,
    2,
  ),
)
if (subjects.length === 0) {
  const reason = scope.subjects.length
    ? 'No mutation subjects in this partition and rotation'
    : scope.noMutationReason
  writeFileSync(
    resolve(output, 'summary.json'),
    JSON.stringify({ passed: true, complete: true, files: [], reason, ...selection }, null, 2),
  )
  process.stdout.write(`${reason}; scope evidence: ${resolve(output, 'scope.json')}\n`)
} else if (scope.baseScore) {
  const thresholds = baseScores(subjects)
  runMutation({
    root,
    subjects,
    testsByFile: scope.testsByFile,
    additionalTestsByFile: {},
    reportDir: output,
    thresholds,
    collectAll: true,
    allowCaseBatches: true,
  })
} else
  runMutation({
    root,
    subjects,
    testsByFile: scope.testsByFile,
    additionalTestsByFile: scope.additionalTestsByFile,
    reportDir: output,
    collectAll: values.full,
  })

/** The same tests against the same mutants on the base revision; incomplete evidence fails. */
function baseScores(selected) {
  if (!values['base-root'])
    throw new Error('A dependency-only update needs --base-root to measure base scores')
  const baseRoot = resolve(values['base-root'])
  const baseHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: baseRoot,
    encoding: 'utf8',
  }).trim()
  if (baseHead !== values.base) throw new Error('--base-root is not a checkout of the authoritative --base')
  for (const file of new Set([...selected, ...selected.flatMap((subject) => scope.testsByFile[subject])])) {
    if (!readFileSync(resolve(baseRoot, file)).equals(readFileSync(resolve(root, file))))
      throw new Error(`${file} differs between base and head; it is not a dependency-only update`)
  }
  const base = runMutation({
    root: baseRoot,
    subjects: selected,
    testsByFile: scope.testsByFile,
    additionalTestsByFile: {},
    reportDir: join(output, 'base'),
    threshold: 0,
    collectAll: true,
    allowCaseBatches: true,
  })
  // A mutant that timed out counts as undetected on both sides; one never run lowers nothing.
  const incomplete = base.files.filter((row) => row.unevaluated)
  if (incomplete.length)
    throw new Error(
      `Base scores are incomplete: mutants were not evaluated within the budget in ${incomplete.map((row) => row.file).join(', ')}`,
    )
  const scores = Object.fromEntries(base.files.map((row) => [row.file, row.score ?? 0]))
  writeFileSync(join(output, 'base-scores.json'), JSON.stringify(scores, null, 2))
  return scores
}

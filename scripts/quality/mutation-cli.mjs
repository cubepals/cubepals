// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** CI entrypoint: one exhaustive source partition, with incremental test-aware subject selection. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { qualityOnlyChanges } from './config-impact.mjs'
import { inventory, sourceFiles } from './inventory.mjs'
import { runMutation } from './mutation.mjs'
import { rotationSubjects, selectMutationScope } from './mutation-scope.mjs'
import { groupOf, groups } from './shards.mjs'

const { values } = parseArgs({
  options: {
    changed: { type: 'string' },
    comparison: { type: 'string' },
    group: { type: 'string' },
    full: { type: 'boolean', default: false },
    rotation: { type: 'string' },
    output: { type: 'string' },
    root: { type: 'string', default: process.cwd() },
  },
})
if (
  !values.group ||
  !Object.hasOwn(groups, values.group) ||
  !values.output ||
  (!values.changed && !values.full)
) {
  throw new Error('Usage: mutation-cli.mjs --changed PATH --group GROUP --output DIR [--full] [--root DIR]')
}
if (values.rotation !== undefined && (!values.full || !/^[0-6]$/.test(values.rotation)))
  throw new Error('--rotation must be 0 through 6 and requires --full')
const root = resolve(values.root)
const output = resolve(values.output)
const changed = values.changed ? JSON.parse(readFileSync(resolve(values.changed), 'utf8')) : []
if (!Array.isArray(changed) || changed.some((file) => typeof file !== 'string'))
  throw new Error('Changed files must be a JSON string array')
const entries = inventory(root)
const comparisonPath = values.comparison
  ? resolve(values.comparison)
  : values.changed
    ? resolve(dirname(resolve(values.changed)), 'comparison.json')
    : null
const comparison =
  comparisonPath && existsSync(comparisonPath) ? JSON.parse(readFileSync(comparisonPath, 'utf8')) : null
const ignoredConfigFiles = comparison?.base ? qualityOnlyChanges(root, comparison.base, changed) : new Set()
const scope = selectMutationScope({
  root,
  productionFiles: sourceFiles(entries),
  testFiles: entries.filter((entry) => entry.kind === 'test').map((entry) => entry.path),
  changedFiles: changed,
  full: values.full,
  ignoredConfigFiles,
})
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
      verifiedQualityOnlyConfigs: [...ignoredConfigFiles],
    },
    null,
    2,
  ),
)
if (subjects.length === 0) {
  const reason = scope.subjects.length
    ? 'No mutation subjects in this partition and rotation'
    : 'No production or test changes'
  writeFileSync(
    resolve(output, 'summary.json'),
    JSON.stringify({ passed: true, complete: true, files: [], reason, ...selection }, null, 2),
  )
  process.stdout.write(`${reason}; scope evidence: ${resolve(output, 'scope.json')}\n`)
} else
  runMutation({ root, subjects, testsByFile: scope.testsByFile, reportDir: output, collectAll: values.full })

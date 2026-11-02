// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Verify all mutation runners against a fresh Git scope and independent candidate census. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MINUTE_MS } from '../../packages/contracts/src/durations.ts'
import { inventory, sourceFiles } from './inventory.mjs'
import { selectReleaseMutationScope } from './mutation-release-scope.mjs'
import { costs, git, mutationAssignment, mutationPartitions } from './partition-plan.mjs'
import { groupOf, groups } from './shards.mjs'

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

export function verifyMutationPartitions({ root, directory, comparison, full = false, rotation = null }) {
  if (git(root, 'rev-parse', 'HEAD') !== comparison.head) throw new Error('Foreign mutation comparison')
  const changedFiles = git(root, 'diff', '--name-only', '--no-renames', comparison.base, comparison.head)
    .split('\n')
    .filter(Boolean)
  const entries = inventory(root)
  const scope = selectReleaseMutationScope({
    root,
    productionFiles: sourceFiles(entries),
    testFiles: entries.filter((entry) => entry.kind === 'test').map((entry) => entry.path),
    changedFiles,
    baseSha: comparison.base,
    headSha: comparison.head,
    full,
  })
  const assignments = Array.from({ length: mutationPartitions }, (_, index) =>
    mutationAssignment(scope.subjects, costs(root).mutations, index, rotation),
  )
  const subjects = assignments.flat().sort()
  if (new Set(subjects).size !== subjects.length) throw new Error('Duplicate mutation assignments')
  mkdirSync(directory, { recursive: true })
  const input = join(directory, 'verified-candidate-input.json'),
    output = join(directory, 'verified-candidates.json')
  writeFileSync(input, JSON.stringify({ root, subjects, rangesByFile: scope.rangesByFile, output }))
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./mutation-candidates.mjs', import.meta.url)), input],
    { cwd: root, stdio: 'inherit' },
  )
  const census = read(output),
    rows = [],
    loads = []
  for (let index = 0; index < mutationPartitions; index++) {
    let elapsed = 0
    for (const group of Object.keys(groups)) {
      const selected = assignments[index].filter((path) => groupOf(path) === group).sort()
      const path = join(directory, String(index), group)
      const declared = read(join(path, 'scope.json')),
        summary = read(join(path, 'summary.json'))
      if (
        JSON.stringify([...declared.selected].sort()) !== JSON.stringify(selected) ||
        declared.partition?.index !== index ||
        declared.partition?.count !== mutationPartitions ||
        declared.rotation !== rotation ||
        declared.full !== full
      )
        throw new Error(`Wrong mutation partition scope: ${index}/${group}`)
      if (
        summary.passed !== true ||
        summary.complete !== true ||
        !Array.isArray(summary.files) ||
        JSON.stringify(summary.files.map((row) => row.file).sort()) !== JSON.stringify(selected)
      )
        throw new Error(`Missing or failed mutation partition: ${index}/${group}`)
      const candidates = selected.length ? read(join(path, 'candidates.json')) : {}
      for (const row of summary.files) {
        if (JSON.stringify(candidates[row.file]) !== JSON.stringify(census[row.file]))
          throw new Error(`Stale or incomplete candidate census: ${row.file}`)
        if (
          row.passed !== true ||
          row.total !== census[row.file].count ||
          row.unevaluated > 0 ||
          row.threshold !== 80 ||
          (row.total > 0 && row.killed / row.total < 0.8)
        )
          throw new Error(`Unproved mutation detection: ${row.file}`)
        rows.push(row)
        elapsed += row.durationMs ?? 0
      }
    }
    loads.push(elapsed)
  }
  const result = {
    passed: true,
    complete: true,
    comparison,
    subjects: subjects.length,
    partitions: mutationPartitions,
    files: rows,
    partitionDurationMs: loads,
  }
  writeFileSync(join(directory, 'verified-summary.json'), `${JSON.stringify(result, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\nMutation evidence: **${subjects.length} files, all ${mutationPartitions} runners complete**.\n\n| File | Detection | Minutes |\n|---|---:|---:|\n${rows.map((row) => `| ${row.file} | ${row.killed}/${row.total} | ${((row.durationMs ?? 0) / MINUTE_MS).toFixed(1)} |`).join('\n')}\n`,
    )
  if (Math.max(...loads) > 20 * MINUTE_MS)
    console.warn('::warning::Mutation work exceeded its 20-minute runtime target; inspect per-file timings.')
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, directory, comparisonPath, mode, rotated] = process.argv.slice(2)
  if (!comparisonPath || !['true', 'false'].includes(mode))
    throw new Error('Usage: mutation-partitions.mjs ROOT DIRECTORY COMPARISON FULL [ROTATION]')
  verifyMutationPartitions({
    root,
    directory,
    comparison: read(comparisonPath),
    full: mode === 'true',
    rotation: rotated ? Number(rotated) : null,
  })
}

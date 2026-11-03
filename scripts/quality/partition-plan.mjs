// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Deterministic, exhaustive scheduling; historical costs affect placement, never selection. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ciImpact } from './ci-impact.mjs'
import { rotationSubjects } from './mutation-scope.mjs'
import { groupOf, groups } from './shards.mjs'

export const nativePartitions = { lifecycle: 3, providers: 2, worlds: 3, mods: 1, access: 3, web: 1, rest: 4 }
export const mutationPartitions = 4
export const isNativeTest = (path) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('scripts/quality/')

export function mutationAssignment(subjects, weights, index, rotation = null) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= mutationPartitions)
    throw new Error('Invalid mutation partition')
  const selected = Object.keys(groups).flatMap((group) => {
    const own = subjects.filter((path) => groupOf(path) === group)
    return rotation === null ? own : rotationSubjects(own, rotation)
  })
  return balance(selected, weights, mutationPartitions)[index]
}

export function balance(paths, costs, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 16) throw new Error('Invalid partition count')
  if (
    !Array.isArray(paths) ||
    paths.some((path) => typeof path !== 'string' || !path) ||
    new Set(paths).size !== paths.length
  )
    throw new Error('Partition inputs must be unique paths')
  const cost = (path) => {
    const value = Object.hasOwn(costs, path) ? costs[path] : 1
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid scheduling cost: ${path}`)
    return value
  }
  const bins = Array.from({ length: count }, () => ({ paths: [], cost: 0 }))
  for (const path of [...paths].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const bin = bins.reduce((best, next) => (next.cost < best.cost ? next : best))
    bin.paths.push(path)
    bin.cost += cost(path)
  }
  return bins.map((bin) => bin.paths.sort())
}

export const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()

export function costs(root) {
  return JSON.parse(readFileSync(resolve(root, 'scripts/quality/runtime-costs.json'), 'utf8'))
}

export function testPlan(
  root,
  base,
  head = git(root, 'rev-parse', 'HEAD'),
  mode = process.env.QUALITY_EXECUTION_SCOPE ?? 'full',
) {
  for (const sha of [base, head])
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Partition commits must be exact SHAs')
  const list = (sha) => git(root, 'ls-tree', '-r', '--name-only', sha).split('\n').filter(isNativeTest)
  const baseTests = list(base),
    headTests = list(head)
  const impact = ciImpact(root, base, head, mode)
  const selectedBase = new Set(impact.tests[0]),
    selectedHead = new Set(impact.tests[1])
  const union = [...new Set([...impact.tests[0], ...impact.tests[1]])]
  const weights = costs(root).tests
  return {
    version: 2,
    base,
    head,
    mode,
    impact: { ...impact, tests: undefined },
    groups: Object.fromEntries(
      Object.keys(groups).map((group) => [
        group,
        {
          baseInventory: baseTests.filter((path) => groupOf(path) === group).sort(),
          headInventory: headTests.filter((path) => groupOf(path) === group).sort(),
          baseTests: baseTests.filter((path) => groupOf(path) === group && selectedBase.has(path)).sort(),
          headTests: headTests.filter((path) => groupOf(path) === group && selectedHead.has(path)).sort(),
          partitions: balance(
            union.filter((path) => groupOf(path) === group),
            weights,
            impact.complete
              ? nativePartitions[group]
              : Math.max(
                  1,
                  Math.min(
                    nativePartitions[group],
                    Math.ceil(
                      union
                        .filter((path) => groupOf(path) === group)
                        .reduce((sum, path) => sum + (weights[path] ?? 1), 0) / 180,
                    ),
                  ),
                ),
          ),
        },
      ]),
    ),
  }
}

export function selectedTests(plan, root, group, index, tests) {
  const sha = git(root, 'rev-parse', 'HEAD')
  const side = sha === plan.base ? 'baseTests' : sha === plan.head ? 'headTests' : null
  const own = plan.groups?.[group]
  if (plan.version !== 2 || !side || !own || !Number.isSafeInteger(index) || !own.partitions[index])
    throw new Error('Foreign or invalid test partition')
  if (
    JSON.stringify([...tests].sort()) !==
    JSON.stringify(own[side === 'baseTests' ? 'baseInventory' : 'headInventory'])
  )
    throw new Error('Partition inventory differs from the checkout')
  const selected = new Set(own.partitions[index].filter((path) => own[side].includes(path)))
  return tests.filter((path) => selected.has(path))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, base, output] = process.argv.slice(2)
  if (!root || !base || !output) throw new Error('Usage: partition-plan.mjs ROOT BASE OUTPUT')
  writeFileSync(output, `${JSON.stringify(testPlan(root, base), null, 2)}\n`)
}

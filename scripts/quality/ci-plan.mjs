// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Publishes the same Git-bound plan that every evidence consumer independently reconstructs. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inventory } from './inventory.mjs'
import { testPlan } from './partition-plan.mjs'

const root = process.cwd()
const directory = resolve(process.argv[2] ?? 'coverage/quality')
const comparison = JSON.parse(readFileSync(resolve(directory, 'comparison.json'), 'utf8'))
const plan = testPlan(root, comparison.base, comparison.head)
writeFileSync(resolve(directory, 'test-plan.json'), `${JSON.stringify(plan)}\n`)
const matrix = {
  include: Object.entries(plan.groups).flatMap(([quality, group]) =>
    group.partitions.flatMap((paths, partition) =>
      paths.length ? [{ quality, partition, services: plan.impact.services }] : [],
    ),
  ),
}
const production = new Set(
  inventory(root)
    .filter((entry) => entry.kind === 'source')
    .map((entry) => entry.path),
)
const mutation =
  process.env.QUALITY_FULL_AUDIT === 'true' || plan.impact.changed.some((path) => production.has(path))
const outputs = {
  ...plan.impact.checks,
  scope: plan.mode,
  mutation,
  complete: plan.impact.complete,
  matrix: JSON.stringify(matrix),
  services: plan.impact.services,
}
for (const [key, value] of Object.entries(outputs)) {
  if (key === 'reasons' || key === 'website' || key === 'broad' || key === 'configuration') continue
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
console.warn(
  JSON.stringify({
    mode: plan.mode,
    changed: plan.impact.changed,
    tests: Object.values(plan.groups).reduce((n, group) => n + group.headTests.length, 0),
    jobs: matrix.include.length,
    checks: plan.impact.checks,
    reasons: plan.impact.reasons,
  }),
)

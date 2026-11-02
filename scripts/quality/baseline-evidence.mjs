// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Validate immutable main-run baseline data before allowing a fresh measurement to be skipped. */
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOUR_MS } from '../../packages/contracts/src/durations.ts'
import { baselineIdentity, calendarKey, digest, trustedProducer } from './baseline-identity.mjs'
import { validateReport } from './coverage.mjs'
import { checkJUnit } from './coverage-junit.mjs'
import { inventory } from './inventory.mjs'
import { legacyCalendarSkips } from './legacy-calendar-case.mjs'
import { orderMutationTests } from './mutation-test-order.mjs'
import { git } from './partition-plan.mjs'
import { groupOf, groups } from './shards.mjs'

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
export const baselineFiles = () =>
  Object.keys(groups)
    .flatMap((group) => [
      `${group}.json`,
      `${group}.xml`,
      `manifests/${group}.json`,
      `test-execution/${group}.json`,
      `timings/${group}.json`,
    ])
    .sort()

export function validateDataset(directory, checkout, identity, at = new Date()) {
  if (git(checkout, 'rev-parse', 'HEAD') !== identity.source || identity.calendar !== calendarKey(at))
    throw new Error('Baseline source or calendar context differs')
  const entries = inventory(checkout),
    expected = baselineFiles()
  const found = []
  const visit = (path, prefix = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isDirectory()) visit(join(path, entry.name), `${name}/`)
      else if (entry.isFile()) found.push(name)
      else throw new Error('Baseline evidence cannot contain links or special files')
    }
  }
  visit(directory)
  if (JSON.stringify(found.sort()) !== JSON.stringify(expected))
    throw new Error('Missing or foreign baseline evidence files')
  for (const group of Object.keys(groups)) {
    const report = validateReport(read(join(directory, `${group}.json`)))
    if (
      JSON.stringify(report.inventory) !== JSON.stringify(entries) ||
      JSON.stringify(report.shards) !== JSON.stringify([group])
    )
      throw new Error(`Stale baseline source inventory: ${group}`)
    const tests = entries
      .filter((entry) => entry.kind === 'test' && groupOf(entry.path) === group)
      .map(({ path, sha256 }) => ({ path, sha256 }))
    const manifest = read(join(directory, 'manifests', `${group}.json`))
    if (manifest.fingerprint !== identity.fingerprint)
      throw new Error(`Baseline measurement environment differs: ${group}`)
    if (
      manifest.version !== 1 ||
      JSON.stringify(
        [...(manifest.tests ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ) !== JSON.stringify(tests)
    )
      throw new Error(`Stale baseline test inventory: ${group}`)
    const began = new Date(manifest.startedAt),
      ended = new Date(manifest.completedAt)
    if (
      !Number.isFinite(+began) ||
      !Number.isFinite(+ended) ||
      ended < began ||
      ended > at ||
      +at - +began > 3 * HOUR_MS ||
      calendarKey(began) !== identity.calendar ||
      calendarKey(ended) !== identity.calendar
    )
      throw new Error(`Expired baseline measurement: ${group}`)
    const allowed = new Set(tests.flatMap((test) => [...legacyCalendarSkips(test, began, ended)]))
    checkJUnit(
      readFileSync(join(directory, `${group}.xml`), 'utf8'),
      tests.map((test) => test.path),
      { allowedSkippedTests: allowed },
    )
    const profile = read(join(directory, 'test-execution', `${group}.json`))
    orderMutationTests({ subjects: [], testsByFile: {}, additionalTestsByFile: {} }, profile, entries, group)
    const timings = read(join(directory, 'timings', `${group}.json`))
    if (
      JSON.stringify(Object.keys(timings).sort()) !== JSON.stringify(tests.map((test) => test.path)) ||
      Object.values(timings).some((value) => !Number.isFinite(value) || value < 0)
    )
      throw new Error(`Incomplete baseline timing inventory: ${group}`)
  }
  return Object.fromEntries(expected.map((path) => [path, digest(readFileSync(join(directory, path)))]))
}

export function packBaseline({ root, checkout, directory, output, producer, at = new Date(), runtime }) {
  const identity = baselineIdentity(root, git(checkout, 'rev-parse', 'HEAD'), at, runtime)
  const files = validateDataset(directory, checkout, identity, at)
  mkdirSync(output, { recursive: true })
  cpSync(directory, join(output, 'data'), { recursive: true })
  writeFileSync(
    join(output, 'manifest.json'),
    `${JSON.stringify({ ...identity, producer, files }, null, 2)}\n`,
  )
  return identity
}

export function validateBaseline({
  checkout,
  directory,
  identity,
  producer,
  repository,
  repositoryId,
  at = new Date(),
}) {
  if (!trustedProducer(producer, repository, repositoryId))
    throw new Error('Baseline producer is not a successful main CI run')
  const manifest = read(join(directory, 'manifest.json'))
  for (const field of ['version', 'source', 'fingerprint', 'calendar', 'key'])
    if (manifest[field] !== identity[field]) throw new Error(`Baseline identity mismatch: ${field}`)
  for (const field of ['id', 'head', 'branch', 'event', 'workflow', 'repository', 'repositoryId'])
    if (String(manifest.producer?.[field]) !== String(producer[field]))
      throw new Error(`Baseline producer mismatch: ${field}`)
  const files = validateDataset(join(directory, 'data'), checkout, identity, at)
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error('Baseline evidence digest mismatch')
  return manifest
}

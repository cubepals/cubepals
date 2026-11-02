// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Reassembles isolated runners only after proving their exact, disjoint test inventories. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { revalidateBaseline } from './baseline-cache.mjs'
import { mergeReports } from './coverage.mjs'
import { checkJUnit, mergeJUnit } from './coverage-junit.mjs'
import { inventory } from './inventory.mjs'
import { legacyCalendarSkips } from './legacy-calendar-case.mjs'
import { nativePartitions, testPlan } from './partition-plan.mjs'
import { groups } from './shards.mjs'

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const write = (path, data) => writeFileSync(path, `${JSON.stringify(data)}\n`)

export function mergeNativePartitions({ root, baseRoot, directory, base, cachedBaseline }) {
  const plan = testPlan(root, base)
  if (cachedBaseline) {
    revalidateBaseline({ root, checkout: baseRoot, directory: cachedBaseline })
    mkdirSync(join(directory, 'merged'), { recursive: true })
    cpSync(join(cachedBaseline, 'data'), join(directory, 'merged', 'base'), { recursive: true })
  }
  for (const [side, checkout] of [
    ['base', baseRoot],
    ['head', root],
  ]) {
    if (side === 'base' && cachedBaseline) continue
    const entries = inventory(checkout)
    const hashes = new Map(
      entries.filter((entry) => entry.kind === 'test').map((entry) => [entry.path, entry.sha256]),
    )
    const sources = Object.fromEntries(
      entries.filter((entry) => entry.kind === 'source').map((entry) => [entry.path, entry.sha256]),
    )
    const input = join(directory, side)
    const output = join(directory, 'merged', side)
    mkdirSync(join(output, 'manifests'), { recursive: true })
    mkdirSync(join(output, 'test-execution'), { recursive: true })
    mkdirSync(join(output, 'timings'), { recursive: true })
    for (const group of Object.keys(groups)) {
      const expected = plan.groups[group][`${side}Tests`]
      const wanted = new Set(expected)
      const seen = new Set()
      const reports = [],
        documents = [],
        tests = []
      const execution = { version: 1, group, sources, tests: {} }
      const timings = {}
      const intervals = []
      for (let index = 0; index < nativePartitions[group]; index++) {
        const id = `${group}-${index}`
        const report = read(join(input, `${id}.json`))
        if (
          JSON.stringify(report.inventory) !== JSON.stringify(entries) ||
          JSON.stringify(report.shards) !== JSON.stringify([id])
        )
          throw new Error(`Foreign inventory or partition report: ${id}`)
        const manifest = read(join(input, 'manifests', `${id}.json`))
        if (manifest.version !== 1 || !Array.isArray(manifest.tests))
          throw new Error(`Missing partition manifest: ${id}`)
        const own = manifest.tests.map((test) => test.path).sort()
        const selected = plan.groups[group].partitions[index].filter((path) => wanted.has(path))
        if (JSON.stringify(own) !== JSON.stringify(selected))
          throw new Error(`Missing or foreign partition tests: ${id}`)
        const measured = read(join(input, 'timings', `${id}.json`))
        if (
          JSON.stringify(Object.keys(measured).sort()) !== JSON.stringify(own) ||
          Object.values(measured).some((ms) => !Number.isFinite(ms) || ms < 0)
        )
          throw new Error(`Missing or invalid per-file timings: ${id}`)
        Object.assign(timings, measured)
        const profile = read(join(input, 'test-execution', `${id}.json`))
        if (
          profile.version !== 1 ||
          profile.group !== group ||
          JSON.stringify(profile.sources) !== JSON.stringify(sources)
        )
          throw new Error(`Foreign execution profile: ${id}`)
        if (JSON.stringify(Object.keys(profile.tests).sort()) !== JSON.stringify(own))
          throw new Error(`Incomplete execution profile: ${id}`)
        for (const test of manifest.tests) {
          if (
            seen.has(test.path) ||
            hashes.get(test.path) !== test.sha256 ||
            profile.tests[test.path]?.sha256 !== test.sha256 ||
            !profile.tests[test.path]?.files
          )
            throw new Error(`Duplicate or stale partition test: ${test.path}`)
          seen.add(test.path)
          tests.push(test)
          execution.tests[test.path] = profile.tests[test.path]
        }
        const xml = readFileSync(join(input, `${id}.xml`), 'utf8')
        const started = new Date(manifest.startedAt),
          completed = new Date(manifest.completedAt)
        intervals.push({ started, completed, fingerprint: manifest.fingerprint })
        if (
          !Number.isFinite(+started) ||
          !Number.isFinite(+completed) ||
          completed < started ||
          completed > new Date()
        )
          throw new Error(`Invalid partition execution interval: ${id}`)
        const allowed = new Set(
          manifest.tests.flatMap((test) => [...legacyCalendarSkips(test, started, completed)]),
        )
        checkJUnit(xml, own, { allowedSkippedTests: allowed })
        documents.push(xml)
        reports.push(report)
      }
      if (seen.size !== wanted.size) throw new Error(`Incomplete ${side} ${group} test evidence`)
      const combined = mergeReports(reports, nativePartitions[group])
      combined.shards = [group]
      write(join(output, `${group}.json`), combined)
      writeFileSync(join(output, `${group}.xml`), mergeJUnit(documents))
      write(join(output, 'manifests', `${group}.json`), {
        version: 1,
        tests: tests.sort((a, b) => a.path.localeCompare(b.path)),
        startedAt: new Date(Math.min(...intervals.map((interval) => +interval.started))).toISOString(),
        completedAt: new Date(Math.max(...intervals.map((interval) => +interval.completed))).toISOString(),
        fingerprint:
          new Set(intervals.map((interval) => interval.fingerprint)).size === 1
            ? intervals[0].fingerprint
            : null,
      })
      write(join(output, 'test-execution', `${group}.json`), execution)
      write(join(output, 'timings', `${group}.json`), timings)
      console.warn(
        `${side} ${group}: ${seen.size} test files verified across ${nativePartitions[group]} runners`,
      )
    }
  }
  return plan
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, baseRoot, directory, base, cachedBaseline] = process.argv.slice(2)
  if (!base) throw new Error('Usage: coverage-partitions.mjs ROOT BASE_ROOT DIRECTORY BASE_SHA')
  mergeNativePartitions({ root, baseRoot, directory, base, cachedBaseline })
}

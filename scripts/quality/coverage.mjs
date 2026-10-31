// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Validates and merges branch evidence without trusting the runner's aggregate percentage.
 * Missing files, shards, counters or source identities fail closed. Changed/new modules meet
 * per-file floors; every measured existing module also keeps its measured base percentages.
 * Legacy deficits are reported individually, never converted into an invented passing baseline.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventory, sourceFiles } from './inventory.mjs'

export const FLOORS = Object.freeze({ branches: 80, functions: 90, lines: 90 })

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing ${label}`)
}

function pathName(path) {
  if (
    typeof path !== 'string' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '..' || part === '.' || part === '')
  )
    throw new Error(`Invalid evidence path: ${path}`)
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid counter: ${label}`)
}

function sameKeys(map, counters, label) {
  object(map, `${label} map`)
  object(counters, `${label} counters`)
  if (JSON.stringify(Object.keys(map).sort()) !== JSON.stringify(Object.keys(counters).sort()))
    throw new Error(`Missing or extra counters: ${label}`)
}

function location(value, label) {
  object(value, label)
  for (const edge of ['start', 'end']) {
    object(value[edge], `${label}.${edge}`)
    if (
      !Number.isSafeInteger(value[edge].line) ||
      value[edge].line < 1 ||
      !Number.isSafeInteger(value[edge].column) ||
      value[edge].column < 0
    )
      throw new Error(`Invalid source location: ${label}`)
  }
}

export function validateReport(report) {
  object(report, 'coverage report')
  if (report.version !== 1) throw new Error('Unsupported coverage evidence version')
  if (!Array.isArray(report.inventory) || report.inventory.length === 0)
    throw new Error('Missing source inventory')
  if (
    !Array.isArray(report.shards) ||
    report.shards.length === 0 ||
    report.shards.some((name) => typeof name !== 'string' || !name) ||
    new Set(report.shards).size !== report.shards.length
  )
    throw new Error('Missing or duplicate evidence shards')
  const seen = new Set()
  for (const entry of report.inventory) {
    object(entry, 'inventory entry')
    pathName(entry.path)
    if (seen.has(entry.path)) throw new Error(`Duplicate inventory file: ${entry.path}`)
    seen.add(entry.path)
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Missing source hash: ${entry.path}`)
    if (!['source', 'test', 'declaration', 'infrastructure'].includes(entry.kind))
      throw new Error(`Invalid source classification: ${entry.path}`)
  }
  object(report.files, 'file coverage')
  const expected = sourceFiles(report.inventory).sort()
  if (JSON.stringify(expected) !== JSON.stringify(Object.keys(report.files).sort()))
    throw new Error('Coverage files do not exactly match the executable source inventory')
  for (const [path, file] of Object.entries(report.files)) validateFileCoverage(path, file)
  return report
}

export function validateFileCoverage(path, file) {
  object(file, `coverage for ${path}`)
  if (file.path !== path) throw new Error(`Coverage path mismatch: ${path}`)
  sameKeys(file.statementMap, file.s, `${path} statements`)
  sameKeys(file.fnMap, file.f, `${path} functions`)
  sameKeys(file.branchMap, file.b, `${path} branches`)
  for (const [key, value] of Object.entries(file.s)) {
    count(value, `${path} statement ${key}`)
    location(file.statementMap[key], `${path} statement ${key}`)
  }
  for (const [key, value] of Object.entries(file.f)) {
    count(value, `${path} function ${key}`)
    location(file.fnMap[key].loc, `${path} function ${key}`)
  }
  for (const [key, values] of Object.entries(file.b)) {
    const locations = file.branchMap[key].locations
    if (
      !Array.isArray(values) ||
      !Array.isArray(locations) ||
      values.length === 0 ||
      values.length !== locations.length
    )
      throw new Error(`Missing branch arms: ${path} branch ${key}`)
    values.forEach((value, arm) => {
      count(value, `${path} branch ${key}/${arm}`)
      const implicitElse =
        file.branchMap[key].type === 'if' &&
        arm === 1 &&
        locations[arm]?.start?.line === undefined &&
        locations[arm]?.end?.line === undefined
      if (!implicitElse) location(locations[arm], `${path} branch ${key}/${arm}`)
    })
  }
  return file
}

export function coverageIdentity(file) {
  return JSON.stringify([file.statementMap, file.fnMap, file.branchMap])
}

export function mergeReports(reports, expectedShards) {
  if (!Array.isArray(reports) || reports.length === 0) throw new Error('No coverage reports supplied')
  reports.forEach(validateReport)
  if (!Number.isSafeInteger(expectedShards) || expectedShards < 1)
    throw new Error('Expected shard count must be explicit and positive')
  const shards = reports.flatMap((report) => report.shards)
  if (shards.length !== expectedShards || new Set(shards).size !== expectedShards)
    throw new Error(`Expected ${expectedShards} distinct shards, received ${shards.length}`)
  const result = structuredClone(reports[0])
  result.shards = shards
  for (const report of reports.slice(1)) {
    if (JSON.stringify(report.inventory) !== JSON.stringify(result.inventory))
      throw new Error('Shards measured different source inventories or source hashes')
    for (const [path, file] of Object.entries(report.files)) {
      const into = result.files[path]
      if (coverageIdentity(into) !== coverageIdentity(file))
        throw new Error(`Counter maps differ across shards: ${path}`)
      for (const metric of ['s', 'f'])
        for (const [key, value] of Object.entries(file[metric])) into[metric][key] += value
      for (const [key, values] of Object.entries(file.b))
        values.forEach((value, arm) => {
          into.b[key][arm] += value
        })
    }
  }
  return validateReport(result)
}

function metric(values) {
  const total = values.length
  const covered = values.filter((value) => value > 0).length
  return { covered, total, percent: total === 0 ? 100 : (covered / total) * 100 }
}

export function fileMetrics(file) {
  const lines = new Map()
  for (const [key, hits] of Object.entries(file.s)) {
    const line = file.statementMap[key].start.line
    lines.set(line, Math.max(lines.get(line) ?? 0, hits))
  }
  return {
    branches: metric(Object.values(file.b).flat()),
    functions: metric(Object.values(file.f)),
    lines: metric([...lines.values()]),
  }
}

export function checkCoverage(report, base, changed, currentInventory) {
  validateReport(report)
  validateReport(base)
  if (!Array.isArray(changed) || changed.some((path) => typeof path !== 'string'))
    throw new Error('Changed files must be an explicit JSON string array')
  changed.forEach(pathName)
  const runtimeIdentity = (entries) => entries.filter((entry) => entry.kind !== 'infrastructure')
  if (
    currentInventory &&
    JSON.stringify(runtimeIdentity(report.inventory)) !== JSON.stringify(runtimeIdentity(currentInventory))
  )
    throw new Error('Coverage evidence does not describe the current checkout')
  const baseEntries = new Map(base.inventory.map((entry) => [entry.path, entry]))
  const changedSet = new Set(changed)
  const failures = []
  const legacyDeficits = []
  for (const entry of report.inventory.filter((item) => item.kind === 'source')) {
    const previous = baseEntries.get(entry.path)
    const touched = changedSet.has(entry.path) || previous?.sha256 !== entry.sha256
    const metrics = fileMetrics(report.files[entry.path])
    const previousMetrics = base.files[entry.path] && fileMetrics(base.files[entry.path])
    for (const [name, floor] of Object.entries(FLOORS)) {
      const current = metrics[name]
      const prior = previousMetrics?.[name]
      if (touched && current.percent < floor)
        failures.push(`${entry.path}: ${name} ${current.percent.toFixed(2)}% is below ${floor}%`)
      else if (!touched && current.percent < floor)
        legacyDeficits.push({ path: entry.path, metric: name, ...current, floor })
      if (prior && current.percent + Number.EPSILON < prior.percent)
        failures.push(
          `${entry.path}: ${name} regressed from ${prior.percent.toFixed(2)}% to ${current.percent.toFixed(2)}%`,
        )
      if (prior && current.total - current.covered > prior.total - prior.covered)
        failures.push(
          `${entry.path}: uncovered ${name} increased from ${prior.total - prior.covered} to ${current.total - current.covered}`,
        )
    }
  }
  return { failures, legacyDeficits, measuredFiles: Object.keys(report.files).length }
}

function readJson(path) {
  if (!path) throw new Error('A required evidence filename is missing')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function args(values) {
  const flags = {}
  const paths = []
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (!value.startsWith('--')) {
      paths.push(value)
      continue
    }
    if (!['--output', '--report', '--base', '--changed', '--root', '--expected-shards'].includes(value))
      throw new Error(`Unknown argument: ${value}`)
    if (!values[i + 1] || values[i + 1].startsWith('--')) throw new Error(`Missing value: ${value}`)
    if (flags[value] !== undefined) throw new Error(`Repeated argument: ${value}`)
    flags[value] = values[++i]
  }
  return { flags, paths }
}

export function main(values) {
  const [command, ...rest] = values
  const { flags, paths } = args(rest)
  let result
  if (command === 'inventory') result = inventory(resolve(flags['--root'] ?? process.cwd()))
  else if (command === 'merge') result = mergeReports(paths.map(readJson), Number(flags['--expected-shards']))
  else if (command === 'check') {
    result = checkCoverage(
      readJson(flags['--report']),
      readJson(flags['--base']),
      readJson(flags['--changed']),
      flags['--root'] ? inventory(resolve(flags['--root'])) : undefined,
    )
  } else throw new Error('Use inventory, merge, or check')
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  if (flags['--output']) writeFileSync(flags['--output'], serialized)
  else process.stdout.write(serialized)
  if (result.failures?.length) {
    process.stderr.write(`${result.failures.join('\n')}\n`)
    return 1
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

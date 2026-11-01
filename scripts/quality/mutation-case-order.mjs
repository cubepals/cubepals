// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs fast cases first without dropping an oracle. Every split must pass on clean source;
 * context-dependent suites retain their original invocation. A survivor must execute every
 * original case. A kill still needs a real assertion failure, with all raw batch reports kept.
 */
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { readMutationJUnit } from './mutation-evidence.mjs'

const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function inventory(cases, expected) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('Missing mutation case inventory')
  const known = new Map()
  for (const item of cases) {
    if (
      !item ||
      !expected.includes(item.file) ||
      typeof item.name !== 'string' ||
      !item.name ||
      typeof item.id !== 'string' ||
      known.has(item.id)
    )
      throw new Error('Invalid or duplicate mutation case identity')
    const identity = JSON.parse(item.id)
    if (
      !Array.isArray(identity) ||
      identity.length !== 3 ||
      identity[0] !== item.file ||
      typeof identity[1] !== 'string' ||
      identity[2] !== item.name ||
      item.status !== 'passed' ||
      !Number.isFinite(item.durationMs) ||
      item.durationMs < 0
    )
      throw new Error('Mutation case inventory differs from its clean baseline')
    known.set(item.id, item)
  }
  for (const file of expected)
    if (!cases.some((item) => item.file === file)) throw new Error(`Missing mutation cases for ${file}`)
  return known
}

function readBatch(result, batch, known, { proving = false } = {}) {
  const selected = new Set(batch.cases ?? [])
  const filtered = new Set([...known.keys()].filter((id) => proving || !selected.has(id)))
  const cases = []
  const outcome = readMutationJUnit(result.xml, [batch.file], {
    bail: !proving,
    filteredCases: filtered,
    caseResults: cases,
  })
  if (outcome.skipped > 0) throw new Error('A proven mutation batch introduced a skipped case')
  const seen = new Set()
  for (const item of cases) {
    if (!known.has(item.id) || seen.has(item.id)) throw new Error('Unexpected mutation batch case')
    seen.add(item.id)
    if (item.status !== 'filtered' && !proving && !selected.has(item.id))
      throw new Error('Mutation batch executed a case outside its proven selection')
  }
  if (
    !Number.isInteger(result.exitCode) ||
    result.exitCode < 0 ||
    (result.exitCode === 0) !== (outcome.failed === 0)
  )
    throw new Error('Mutation batch exit status disagrees with its test evidence')
  const executed = cases.filter((item) => item.status !== 'filtered')
  if (outcome.failed === 0 && !proving)
    for (const id of selected)
      if (!executed.some((item) => item.id === id && item.status === 'passed'))
        throw new Error('A surviving mutation batch did not execute every selected case')
  return { outcome, executed }
}

/** `execute` keeps the unmodified runner's reports, output and deadline enforcement. */
export function proveCaseOrder(cases, expected, durationMs, execute) {
  if (cases.length < 6 || durationMs < 5 * SECOND_MS || cases.some((item) => item.status !== 'passed'))
    return null
  try {
    const known = inventory(cases, expected)
    const batches = []
    const covered = new Set()
    for (const file of expected) {
      const own = cases.filter((item) => item.file === file).sort((a, b) => a.durationMs - b.durationMs)
      const size = Math.max(1, Math.ceil(own.length / 8))
      for (let offset = 0; offset < own.length; offset += size) {
        const batch = {
          file,
          pattern: own
            .slice(offset, offset + size)
            .map((item) => escapePattern(item.name))
            .join('|'),
        }
        const result = execute(batch, batches.length)
        const { outcome, executed } = readBatch(result, batch, known, { proving: true })
        if (outcome.failed || !Number.isFinite(result.durationMs) || result.durationMs < 0) return null
        for (const item of executed) covered.add(item.id)
        batches.push({ ...batch, cases: executed.map((item) => item.id), durationMs: result.durationMs })
      }
    }
    if (known.size !== covered.size) return null
    return {
      version: 1,
      cases,
      batches: batches.sort((a, b) => a.durationMs - b.durationMs),
      durationMs: batches.reduce((sum, batch) => sum + batch.durationMs, 0),
      originalDurationMs: durationMs,
    }
  } catch {
    // A split that cannot prove the original oracle is never used for mutations.
    return null
  }
}

/** Every survivor runs the complete original inventory; bail needs an actual test failure. */
export function caseBatchKey(batch) {
  return JSON.stringify([batch.file, batch.cases])
}

export function runCaseOrder(plan, expected, execute, preferred = null) {
  if (plan?.version !== 1 || !Array.isArray(plan.batches) || plan.batches.length === 0)
    throw new Error('Invalid proven mutation case order')
  const known = inventory(plan.cases, expected)
  const planned = new Set()
  for (const batch of plan.batches) {
    if (
      !expected.includes(batch.file) ||
      typeof batch.pattern !== 'string' ||
      !batch.pattern ||
      !Array.isArray(batch.cases) ||
      batch.cases.length === 0 ||
      batch.cases.some((id) => known.get(id)?.file !== batch.file)
    )
      throw new Error('Mutation batch differs from its clean case inventory')
    for (const id of batch.cases) planned.add(id)
  }
  if (planned.size !== known.size) throw new Error('Mutation case order omits original cases')
  if (preferred !== null && !plan.batches.some((batch) => caseBatchKey(batch) === preferred))
    throw new Error('Preferred mutation batch is outside the proven case inventory')
  let ordered = [...plan.batches].sort(
    (a, b) => Number(caseBatchKey(b) === preferred) - Number(caseBatchKey(a) === preferred),
  )
  // Splitting expensive database fixtures can cost more than the original suite. Probe the
  // previously failing batch first, then use the original, already proven file invocation.
  // Every original case remains required, including cases repeated by the initial probe.
  if (Number.isFinite(plan.originalDurationMs) && plan.durationMs > plan.originalDurationMs) {
    const first = ordered[0]
    const files = [...new Set(ordered.map((batch) => batch.file))]
    ordered = [
      first,
      ...files.map((file) => ({
        file,
        cases: plan.cases.filter((item) => item.file === file).map((item) => item.id),
      })),
    ]
  }
  const passed = new Set()
  const failed = new Set()
  const reports = []
  for (const [index, batch] of ordered.entries()) {
    const result = execute(batch, index)
    const { outcome, executed } = readBatch(result, batch, known)
    reports.push(result.report)
    for (const item of executed) (item.status === 'passed' ? passed : failed).add(item.id)
    if (outcome.failed > 0)
      return {
        passed: passed.size,
        failed: failed.size,
        skipped: 0,
        skippedTests: [],
        reports,
        failedBatch: caseBatchKey(
          plan.batches.find((original) => original.cases.some((id) => failed.has(id))) ?? batch,
        ),
      }
  }
  if (passed.size !== known.size) throw new Error('A surviving mutant did not execute every original case')
  return { passed: passed.size, failed: 0, skipped: 0, skippedTests: [], reports }
}

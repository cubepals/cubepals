// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The required CI status accepts skipped work only when its change classification permits it. */
import { pathToFileURL } from 'node:url'

export function verifyJobs(needs) {
  const required = [
    'changes',
    'licenses',
    'static',
    'test',
    'quality',
    'worker',
    'images',
    'reporter',
    'fleet',
  ]
  if (!needs || typeof needs !== 'object') throw new Error('Missing CI dependency results')
  for (const name of required) if (!needs[name]) throw new Error(`Missing CI job: ${name}`)
  if (needs.changes.result !== 'success' || needs.licenses.result !== 'success')
    throw new Error('Change detection and licenses must succeed')
  const { code, reporter, fleet } = needs.changes.outputs ?? {}
  if ([code, reporter, fleet].some((value) => !['true', 'false'].includes(value)))
    throw new Error('Missing change classification')
  const classifications = { reporter, fleet }
  for (const name of ['static', 'test', 'quality', 'worker', 'images', 'reporter', 'fleet']) {
    const expected = (classifications[name] ?? code) === 'true' ? 'success' : 'skipped'
    if (needs[name].result !== expected)
      throw new Error(`${name}: expected ${expected}, received ${needs[name].result}`)
  }
  return true
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    verifyJobs(JSON.parse(process.env.NEEDS ?? 'null'))
    console.warn('Every required CI job succeeded; all skips match the change classification')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
/**
 * Instruments the complete inventory in a separate Node process. Babel installs global stack
 * formatting hooks during transformation; loading it inside Bun changes application Error
 * behavior, including follow-redirects' custom errors. Only generated code and zero-hit counters
 * cross back into the test process, which also releases the compiler's memory before tests run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventory, sourceFiles } from './inventory.mjs'
import { createInstrumenter } from './toolchain.mjs'

export function prepareCoverage(rootArgument, testPaths) {
  const root = resolve(rootArgument)
  const entries = inventory(root)
  const availableTests = new Map(
    entries.filter((entry) => entry.kind === 'test').map((entry) => [entry.path, entry]),
  )
  const selected = testPaths ?? [...availableTests.keys()]
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length)
    throw new Error('Prepared test paths must be a unique array')
  const tests = [...selected].sort().map((path) => {
    const entry = availableTests.get(path)
    if (!entry) throw new Error(`Prepared test is outside the inventory: ${path}`)
    return { path, sha256: entry.sha256 }
  })
  const templates = {}
  const contents = {}
  for (const path of sourceFiles(entries)) {
    const instrumenter = createInstrumenter({
      coverageVariable: '__qualityCoverage__',
      coverageGlobalScope: 'globalThis',
      coverageGlobalScopeFunc: false,
      esModules: true,
      compact: false,
      preserveComments: true,
      produceSourceMap: false,
      parserPlugins: [
        ...(/\.[cm]?tsx?$/.test(path) ? ['typescript'] : []),
        ...(/\.[jt]sx$/.test(path) ? ['jsx'] : []),
        'importAttributes',
      ],
    })
    const text = readFileSync(resolve(root, path), 'utf8')
    contents[path] = instrumenter.instrumentSync(text, path)
    templates[path] = structuredClone(instrumenter.lastFileCoverage())
  }
  return { version: 2, root, runId: randomUUID(), inventory: entries, tests, templates, contents }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rootArgument, output, testManifest] = process.argv.slice(2)
  if (!rootArgument || !output) throw new Error('Usage: coverage-prepare.mjs root output [test-paths.json]')
  const tests = testManifest ? JSON.parse(readFileSync(testManifest, 'utf8')) : undefined
  writeFileSync(output, JSON.stringify(prepareCoverage(rootArgument, tests)))
}

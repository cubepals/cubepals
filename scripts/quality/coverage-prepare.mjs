// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Instruments the complete inventory in a separate Node process. Babel installs global stack
 * formatting hooks during transformation; loading it inside Bun changes application Error
 * behavior, including follow-redirects' custom errors. Only generated code and zero-hit counters
 * cross back into the test process, which also releases the compiler's memory before tests run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inventory, sourceFiles } from './inventory.mjs'
import { createInstrumenter } from './toolchain.mjs'

const [rootArgument, output] = process.argv.slice(2)
if (!rootArgument || !output) throw new Error('Usage: coverage-prepare.mjs root output')
const root = resolve(rootArgument)
const entries = inventory(root)
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
writeFileSync(output, JSON.stringify({ inventory: entries, templates, contents }))

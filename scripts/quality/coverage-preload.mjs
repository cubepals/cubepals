// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bun keeps its test runner; Istanbul supplies actual branch counters, which native Bun coverage
 * does not. Every executable source is instrumented before tests start, including never-imported
 * modules. Its untouched counters remain zero in the evidence instead of disappearing from it.
 * Use bun test --preload ./scripts/quality/coverage-preload.mjs with QUALITY_REPORT set.
 */
import { afterAll } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { plugin } from 'bun'
import { inventory, sourceFiles } from './inventory.mjs'
import { createInstrumenter } from './toolchain.mjs'

const root = resolve(process.env.QUALITY_ROOT ?? process.cwd())
const output = process.env.QUALITY_REPORT
if (!output) throw new Error('QUALITY_REPORT must name the coverage evidence file')
const entries = inventory(root)
const templates = {}
const contents = new Map()
function instrumenterFor(path) {
  return createInstrumenter({
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
}
for (const path of sourceFiles(entries)) {
  const instrumenter = instrumenterFor(path)
  const text = readFileSync(resolve(root, path), 'utf8')
  contents.set(path, instrumenter.instrumentSync(text, path))
  templates[path] = structuredClone(instrumenter.lastFileCoverage())
}

// Hook only measured files. Passing dependencies through onLoad changes Bun's CommonJS module
// detection even when their bytes are unchanged, breaking packages such as Ajv's default export.
const sourcePaths = [...contents.keys()].map((path) =>
  resolve(root, path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
)
const sourceFilter = sourcePaths.length ? new RegExp(`^(?:${sourcePaths.join('|')})$`) : /a^/

plugin({
  name: 'quality-branch-coverage',
  setup(build) {
    build.onLoad({ filter: sourceFilter }, (args) => {
      const path = relative(root, args.path).replaceAll('\\', '/')
      const instrumented = contents.get(path)
      if (instrumented === undefined) throw new Error(`Uninventoried coverage module: ${path}`)
      return {
        contents: instrumented,
        loader: /\.[jt]sx$/.test(path)
          ? path.endsWith('tsx')
            ? 'tsx'
            : 'jsx'
          : /\.[cm]?ts$/.test(path)
            ? 'ts'
            : 'js',
      }
    })
  },
})

function writeEvidence() {
  const files = { ...templates, ...(globalThis.__qualityCoverage__ ?? {}) }
  mkdirSync(dirname(resolve(output)), { recursive: true })
  writeFileSync(
    output,
    `${JSON.stringify({
      version: 1,
      inventory: entries,
      shards: [process.env.QUALITY_SHARD ?? 'local'],
      files,
    })}\n`,
  )
}

// Bun's test command does not emit Node's process exit event consistently. Its global afterAll
// hook is the supported lifecycle point; the exit hook also covers ordinary Bun script runs.
afterAll(writeEvidence)
process.on('exit', writeEvidence)

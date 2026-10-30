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
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { plugin } from 'bun'

const root = resolve(process.env.QUALITY_ROOT ?? process.cwd())
const output = process.env.QUALITY_REPORT
if (!output) throw new Error('QUALITY_REPORT must name the coverage evidence file')
const preparedDirectory = mkdtempSync(join(tmpdir(), 'quality-instrument-'))
let prepared
try {
  const preparedPath = join(preparedDirectory, 'modules.json')
  const command = spawnSync(
    'node',
    [fileURLToPath(new URL('./coverage-prepare.mjs', import.meta.url)), root, preparedPath],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  if (command.error) throw command.error
  if (command.status !== 0) throw new Error(`Coverage instrumentation failed: ${command.stderr}`)
  prepared = JSON.parse(readFileSync(preparedPath, 'utf8'))
} finally {
  rmSync(preparedDirectory, { recursive: true, force: true })
}
const entries = prepared.inventory
const templates = prepared.templates
const contents = new Map(Object.entries(prepared.contents))

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

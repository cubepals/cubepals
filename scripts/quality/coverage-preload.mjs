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
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { plugin } from 'bun'

const root = resolve(process.env.QUALITY_ROOT ?? process.cwd())
const output = process.env.QUALITY_REPORT
const preparedPath = process.env.QUALITY_PREPARED
const preparedSha256 = process.env.QUALITY_PREPARED_SHA256
const parts = process.env.QUALITY_PARTS
const phase = process.env.QUALITY_PHASE
const shard = process.env.QUALITY_SHARD ?? 'local'
// Bun.main identifies the file before its code can change process state or replace globals.
const testPath = relative(root, Bun.main).replaceAll('\\', '/')
let prepared
if (preparedPath) {
  const bytes = readFileSync(preparedPath)
  if (!parts || !phase || createHash('sha256').update(bytes).digest('hex') !== preparedSha256)
    throw new Error('Missing or changed prepared coverage evidence')
  prepared = JSON.parse(bytes)
} else {
  if (!output) throw new Error('QUALITY_REPORT must name the coverage evidence file')
  const preparedDirectory = mkdtempSync(join(tmpdir(), 'quality-instrument-'))
  try {
    const generatedPath = join(preparedDirectory, 'modules.json')
    const command = spawnSync(
      'node',
      [fileURLToPath(new URL('./coverage-prepare.mjs', import.meta.url)), root, generatedPath],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    if (command.error) throw command.error
    if (command.status !== 0) throw new Error(`Coverage instrumentation failed: ${command.stderr}`)
    prepared = JSON.parse(readFileSync(generatedPath, 'utf8'))
  } finally {
    rmSync(preparedDirectory, { recursive: true, force: true })
  }
}
if (prepared.version !== 2 || prepared.root !== root)
  throw new Error('Prepared coverage does not describe this checkout')
const test = prepared.tests.find((entry) => entry.path === testPath)
if (
  preparedPath &&
  (!test ||
    createHash('sha256')
      .update(readFileSync(resolve(root, testPath)))
      .digest('hex') !== test.sha256)
)
  throw new Error(`Unprepared or changed isolated test: ${testPath}`)
const entries = prepared.inventory
const templates = prepared.templates
const contents = new Map(Object.entries(preparedPath ? prepared.modules : prepared.contents))

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
      const module = contents.get(path)
      if (module === undefined) throw new Error(`Uninventoried coverage module: ${path}`)
      let instrumented = module
      if (preparedPath) {
        const bytes = readFileSync(join(dirname(preparedPath), 'compiled', module.file))
        if (createHash('sha256').update(bytes).digest('hex') !== module.sha256)
          throw new Error(`Compiled coverage source changed: ${path}`)
        instrumented = bytes.toString('utf8')
      }
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
  if (preparedPath) {
    const fragment = {
      version: 1,
      runId: prepared.runId,
      preparedSha256,
      phase,
      test,
      files: globalThis.__qualityCoverage__ ?? {},
    }
    const name = createHash('sha256').update(test.path).digest('hex')
    writeFileSync(join(parts, `${name}.json`), `${JSON.stringify(fragment)}\n`, { flag: 'wx' })
    return
  }
  const files = { ...templates, ...(globalThis.__qualityCoverage__ ?? {}) }
  mkdirSync(dirname(resolve(output)), { recursive: true })
  writeFileSync(
    output,
    `${JSON.stringify({
      version: 1,
      inventory: entries,
      shards: [shard],
      files,
    })}\n`,
  )
}

// Bun's test command does not emit Node's process exit event consistently. Its global afterAll
// hook is the supported lifecycle point; the exit hook also covers ordinary Bun script runs.
afterAll(writeEvidence)
if (!preparedPath) process.on('exit', writeEvidence)

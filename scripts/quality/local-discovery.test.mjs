// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The real Bun discovery configuration routes only Node controllers away from application tests. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'

test('local gates run Node controllers once and retain every neighboring Bun test format', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-local-discovery-'))
  const record = join(root, 'executions.jsonl')
  const put = (path, source) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
  const run = (command, args) => {
    const env = { ...process.env, QUALITY_DISCOVERY_RECORD: record }
    // Exercise a fresh CLI, without inheriting this test runner's child-worker marker.
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(command, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 15 * SECOND_MS,
      maxBuffer: 1024 * 1024,
    })
    assert.ifError(result.error)
    return { status: result.status, output: result.stdout + result.stderr }
  }
  const applications = [
    'apps/probe/application.test.mjs',
    'scripts/quality-other/application.test.mjs',
    'scripts/quality/nested/application.test.mjs',
    'scripts/quality/application.test.ts',
  ]
  try {
    put(
      'scripts/quality/controller.test.mjs',
      `
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import test from 'node:test'
test('controller uses Node', () => {
  assert.equal(typeof Bun, 'undefined', 'Node controller executed under Bun')
  appendFileSync(process.env.QUALITY_DISCOVERY_RECORD, JSON.stringify('controller') + '\\n')
})
`,
    )
    for (const path of applications)
      put(
        path,
        `
import { expect, test } from 'bun:test'
import { appendFileSync } from 'node:fs'
test(${JSON.stringify(path)}, () => {
  expect(typeof Bun.version).toBe('string')
  appendFileSync(process.env.QUALITY_DISCOVERY_RECORD, JSON.stringify(${JSON.stringify(path)}) + '\\n')
})
`,
      )
    const unfiltered = run('bun', ['test'])
    assert.equal(unfiltered.status, 1, unfiltered.output)
    assert.match(unfiltered.output, /Node controller executed under Bun/)
    rmSync(record, { force: true })
    put('bunfig.toml', readFileSync(new URL('../../bunfig.toml', import.meta.url), 'utf8'))
    const bun = run('bun', ['test'])
    assert.equal(bun.status, 0, bun.output)
    const node = run(process.execPath, ['--test', 'scripts/quality/controller.test.mjs'])
    assert.equal(node.status, 0, node.output)
    const executions = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(executions.sort(), [...applications, 'controller'].sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

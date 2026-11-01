// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real Bun still validates evidence after the original checker files change. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SECOND_MS } from '../../packages/contracts/src/durations.ts'
import { freezeMutationRuntime } from './mutation-runtime.mjs'

const trusted = fileURLToPath(new URL('../../', import.meta.url))

test('a pinned real runner survives edits to its original files and never copies application inputs', (t) => {
  const original = mkdtempSync(join(tmpdir(), 'runner-original-'))
  const project = mkdtempSync(join(tmpdir(), 'runner-project-'))
  let pinned
  t.after(() => {
    rmSync(original, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
    if (pinned) rmSync(pinned.root, { recursive: true, force: true })
  })
  mkdirSync(join(original, 'scripts/quality'), { recursive: true })
  for (const file of readdirSync(join(trusted, 'scripts/quality')))
    if (file.endsWith('.mjs'))
      copyFileSync(join(trusted, 'scripts/quality', file), join(original, 'scripts/quality', file))
  mkdirSync(join(original, 'packages/contracts/src'), { recursive: true })
  copyFileSync(
    join(trusted, 'packages/contracts/src/durations.ts'),
    join(original, 'packages/contracts/src/durations.ts'),
  )
  mkdirSync(join(original, 'tools/quality'), { recursive: true })
  copyFileSync(join(trusted, 'tools/quality/package.json'), join(original, 'tools/quality/package.json'))
  symlinkSync(
    join(trusted, 'tools/quality/node_modules'),
    join(original, 'tools/quality/node_modules'),
    'dir',
  )
  writeFileSync(join(original, '.env'), 'fixture-only marker')
  pinned = freezeMutationRuntime(original)
  const before = readFileSync(pinned.command, 'utf8')
  const poison = 'throw new Error("The original checker was changed")\n'
  writeFileSync(join(original, 'scripts/quality/mutation-command.mjs'), poison)
  assert.equal(readFileSync(pinned.command, 'utf8'), before)
  assert.throws(() => readFileSync(join(pinned.root, '.env')), /ENOENT/)
  mkdirSync(join(project, 'apps'))
  writeFileSync(
    join(project, 'apps/a.test.ts'),
    "import{expect,test}from'bun:test';test('real assertion',()=>expect(2+2).toBe(4))\n",
  )
  const manifest = join(project, 'manifest.json'),
    evidence = join(project, 'evidence')
  writeFileSync(
    manifest,
    JSON.stringify({ tests: ['apps/a.test.ts'], evidence, bun: 'bun', timeoutMs: 10 * SECOND_MS }),
  )
  const env = { ...process.env }
  delete env.__STRYKER_ACTIVE_MUTANT__
  const positive = spawnSync(process.execPath, [pinned.command, manifest], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 15 * SECOND_MS,
  })
  assert.equal(positive.status, 0, positive.stderr)
  assert.equal(JSON.parse(readFileSync(join(evidence, 'baseline.json'), 'utf8')).passed, 1)
  const negative = spawnSync(
    process.execPath,
    [join(original, 'scripts/quality/mutation-command.mjs'), manifest],
    { cwd: project, env, encoding: 'utf8' },
  )
  assert.equal(negative.status, 1)
  assert.match(negative.stderr, /original checker was changed/)
})

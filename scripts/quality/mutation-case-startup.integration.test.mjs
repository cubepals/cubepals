// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real cold starts must finish their clean split proof before any reordering is trusted. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'

const command = fileURLToPath(new URL('./mutation-command.mjs', import.meta.url))

test('real case proofs include the cold startup of every independent Bun process', {
  timeout: 2 * MINUTE_MS,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-case-startup-'))
  try {
    mkdirSync(join(root, 'apps'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    writeFileSync(join(root, 'apps/work.ts'), 'export const work = (value: number) => value + 1\n')
    writeFileSync(
      join(root, 'apps/work.test.ts'),
      `
      import {expect,test} from 'bun:test'
      import {work} from './work.ts'
      await Bun.sleep(${5 * SECOND_MS})
      for (const value of [1,2,3,4,5,6]) test('input '+value,()=>expect(work(value)).toBe(value+1))
    `,
    )
    const evidence = join(root, 'evidence'),
      manifest = join(root, 'manifest.json')
    writeFileSync(
      manifest,
      JSON.stringify({
        tests: ['apps/work.test.ts'],
        evidence,
        bun: 'bun',
        timeoutMs: MINUTE_MS,
        deadline: Date.now() + 2 * MINUTE_MS,
        allowCaseBatches: true,
      }),
    )
    const env = { ...process.env }
    delete env.__STRYKER_ACTIVE_MUTANT__
    const baseline = spawnSync(process.execPath, [command, manifest], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: MINUTE_MS,
    })
    assert.equal(baseline.status, 0, baseline.stderr)
    const clean = JSON.parse(readFileSync(join(evidence, 'baseline.json'), 'utf8'))
    assert.equal(clean.passed, 6)
    assert.ok(clean.caseOrder, 'all cold-started clean batches must prove their original assertions')
    assert.equal(clean.caseOrder.batches.length, 6)
    const survivor = spawnSync(process.execPath, [command, manifest], {
      cwd: root,
      env: { ...env, __STRYKER_ACTIVE_MUTANT__: '42' },
      encoding: 'utf8',
      timeout: MINUTE_MS,
    })
    assert.equal(survivor.status, 0, survivor.stderr)
    const result = JSON.parse(readFileSync(join(evidence, '42.json'), 'utf8'))
    assert.equal(result.status, 'passed')
    assert.equal(result.passed, 6)
    assert.equal(result.reports.length, 6)
    assert.ok(result.durationMs >= 30 * SECOND_MS, 'every original case must retain its real cold start')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

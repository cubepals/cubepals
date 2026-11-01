// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real Bun proves case filters, complete survivors, and a concrete arithmetic defect. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MINUTE_MS, SECOND_MS } from '../../packages/contracts/src/durations.ts'

const command = fileURLToPath(new URL('./mutation-command.mjs', import.meta.url))

test('real case ordering runs every survivor case and rejects an actual changed result', {
  timeout: 2 * MINUTE_MS,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-case-proof-'))
  try {
    mkdirSync(join(root, 'apps'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    const source = join(root, 'apps/work.ts')
    writeFileSync(source, 'export const work = (value: number) => value + 1\n')
    writeFileSync(
      join(root, 'apps/work.test.ts'),
      `
      import {expect,test} from 'bun:test'
      import {work} from './work.ts'
      for (const value of [1,2,3,4,5]) test('input '+value,()=>expect(work(value)).toBe(value+1))
      test('slow input',async()=>{await Bun.sleep(${6 * SECOND_MS});expect(work(9)).toBe(10)},${10 * SECOND_MS})
    `,
    )
    const evidence = join(root, 'evidence')
    const manifest = join(root, 'manifest.json')
    writeFileSync(
      manifest,
      JSON.stringify({
        tests: ['apps/work.test.ts'],
        evidence,
        bun: 'bun',
        timeoutMs: 30 * SECOND_MS,
        deadline: Date.now() + MINUTE_MS,
        allowCaseBatches: true,
      }),
    )
    const run = (mutant) => {
      const env = { ...process.env }
      if (mutant === undefined) delete env.__STRYKER_ACTIVE_MUTANT__
      else env.__STRYKER_ACTIVE_MUTANT__ = mutant
      const result = spawnSync(process.execPath, [command, manifest], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: MINUTE_MS,
      })
      const report = JSON.parse(readFileSync(join(evidence, `${mutant ?? 'baseline'}.json`), 'utf8'))
      return { result, report }
    }
    const clean = run()
    assert.equal(clean.result.status, 0, clean.result.stderr)
    assert.ok(clean.report.caseOrder, 'real clean batch filters must be proven')
    assert.equal(clean.report.caseOrder.cases.length, 6)
    const survivor = run('41')
    assert.equal(survivor.result.status, 0, survivor.result.stderr)
    assert.equal(survivor.report.passed, 6)
    assert.equal(survivor.report.reports.length, clean.report.caseOrder.batches.length)
    assert.ok(survivor.report.durationMs >= 6 * SECOND_MS, 'the slow case must still run')
    const late = clean.report.caseOrder.batches
      .slice(1)
      .findLast((batch) => batch.cases.some((id) => /^input /.test(JSON.parse(id)[2])))
    assert.ok(late, 'a later normal-input batch must exist')
    const failingInput = Number(JSON.parse(late.cases[0])[2].slice('input '.length))
    assert.ok([1, 2, 3, 4, 5].includes(failingInput))
    writeFileSync(
      source,
      `export const work = (value: number) => value === ${failingInput} ? value - 1 : value + 1\n`,
    )
    const broken = run('42')
    assert.equal(broken.result.status, 1)
    assert.equal(broken.report.status, 'test-failure')
    assert.ok(broken.report.failed > 0)
    assert.ok(broken.report.reports.length > 1, 'the first defect must reach a later batch')
    const nearby = run('43')
    assert.equal(nearby.report.status, 'test-failure')
    assert.equal(nearby.report.reports.length, 1, 'the last failing batch should now run first')
    writeFileSync(source, 'export const work = (value: number) => value + 1\n')
    const laterSurvivor = run('44')
    assert.equal(laterSurvivor.report.status, 'passed')
    assert.equal(laterSurvivor.report.passed, 6)
    assert.equal(laterSurvivor.report.reports.length, clean.report.caseOrder.batches.length)
    assert.ok(laterSurvivor.report.durationMs >= 6 * SECOND_MS)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

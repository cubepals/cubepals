// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Review availability is proved from the final provider result, never from error text. */
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexReview,
  rateLimited,
  reviewAvailability,
  TOO_MANY_REQUESTS,
  writeCodexAnswer,
  writeReviewAvailability,
} from './second-eye-result.ts'

const limited = { type: 'result', is_error: true, api_error_status: TOO_MANY_REQUESTS }

test('only a final explicit provider 429 makes the review unavailable', () => {
  expect(reviewAvailability('failure', '', [limited])).toBe(false)
  expect(rateLimited([{ ...limited, is_error: false }])).toBe(false)
  expect(rateLimited([{ ...limited, api_error_status: '429' }])).toBe(false)
  expect(rateLimited([{ type: 'assistant', content: 'HTTP 429' }])).toBe(false)
  expect(rateLimited([limited, { type: 'result', is_error: false }])).toBe(false)
  expect(rateLimited({ result: limited })).toBe(false)
})

test.each([401, 403, 500, 503])('HTTP %i remains a failed review', (status) => {
  expect(() => reviewAvailability('failure', '', [{ ...limited, api_error_status: status }])).toThrow()
})

test('missing evidence and empty successful answers cannot skip a review', () => {
  expect(() => reviewAvailability('failure', '', undefined)).toThrow()
  expect(() => reviewAvailability('success', ' ', [])).toThrow()
  expect(reviewAvailability('success', '{"verdict":"merge"}', [])).toBe(true)
})

test('the classifier writes the skip output and plain availability notice, and fails other errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-result-'))
  const execution = join(dir, 'execution.json')
  const output = join(dir, 'output')
  const summary = join(dir, 'summary')
  const run = () =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, 'second-eye-result.ts')], {
      env: {
        ...process.env,
        OUTCOME: 'failure',
        STRUCTURED: '',
        EXECUTION_FILE: execution,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  try {
    writeFileSync(execution, JSON.stringify([limited]))
    expect(run().exitCode).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('unavailable=true\n')
    expect(readFileSync(summary, 'utf8')).toBe('Automated review unavailable. Skipped for this commit.\n')
    writeFileSync(output, '')
    writeFileSync(execution, JSON.stringify([{ ...limited, api_error_status: 401 }]))
    expect(run().exitCode).not.toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('successful, unavailable and invalid runner outputs are distinct', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-availability-'))
  const execution = join(dir, 'execution.json')
  const output = join(dir, 'output')
  const summary = join(dir, 'summary')
  try {
    writeReviewAvailability({ OUTCOME: 'success', STRUCTURED: '{}', GITHUB_OUTPUT: output })
    expect(readFileSync(output, 'utf8')).toBe('unavailable=false\n')
    writeFileSync(output, '')
    writeFileSync(execution, JSON.stringify([limited]))
    writeReviewAvailability({
      EXECUTION_FILE: execution,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    })
    expect(readFileSync(output, 'utf8')).toBe('unavailable=true\n')
    expect(readFileSync(summary, 'utf8')).toContain('Automated review unavailable.')
    writeReviewAvailability({ EXECUTION_FILE: execution, GITHUB_OUTPUT: output })
    expect(() => writeReviewAvailability({ OUTCOME: 'success', STRUCTURED: '{}' })).toThrow('GITHUB_OUTPUT')
    expect(() => writeReviewAvailability({})).toThrow('Automated review failed')
    writeFileSync(execution, '{')
    expect(() => writeReviewAvailability({ EXECUTION_FILE: execution, GITHUB_OUTPUT: output })).toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const answer = {
  verdict: 'fix first',
  files_reviewed: 2,
  earlier: [],
  findings: [
    { severity: 'high', origin: 'first', file: 'a.ts', line: 3, problem: 'p\nq', fix: 'f', why: 'w' },
  ],
}

test("Codex's answer stands only when the step succeeded with one in the review's shape", () => {
  expect(codexReview('success', JSON.stringify(answer))).toEqual(answer as never)
  expect(codexReview('failure', JSON.stringify(answer))).toBeUndefined()
  expect(codexReview('success', '')).toBeUndefined()
  expect(codexReview('success', 'Here is my review: looks fine')).toBeUndefined()
  expect(codexReview('success', 'null')).toBeUndefined()
  expect(codexReview('success', JSON.stringify({ ...answer, verdict: 'approve' }))).toBeUndefined()
  expect(codexReview('success', JSON.stringify({ ...answer, files_reviewed: '2' }))).toBeUndefined()
  expect(codexReview('success', JSON.stringify({ ...answer, earlier: undefined }))).toBeUndefined()
  expect(codexReview('success', JSON.stringify({ ...answer, findings: {} }))).toBeUndefined()
})

test('what became of Codex: answered on one line, failed, or off when its step was skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-answer-'))
  const output = join(dir, 'output')
  const write = (env: Record<string, string>) => {
    writeFileSync(output, '')
    writeCodexAnswer({ GITHUB_OUTPUT: output, ...env })
    return readFileSync(output, 'utf8')
  }
  try {
    expect(write({ OUTCOME: 'success', MESSAGE: JSON.stringify(answer, null, 2) })).toBe(
      `codex=answered\nreview=${JSON.stringify(answer)}\n`,
    )
    expect(write({ OUTCOME: 'success', MESSAGE: '{' })).toBe('codex=failed\nreview=\n')
    expect(write({ OUTCOME: 'failure', MESSAGE: '' })).toBe('codex=failed\nreview=\n')
    expect(write({ OUTCOME: 'skipped' })).toBe('codex=off\nreview=\n')
    expect(write({})).toBe('codex=off\nreview=\n')
    expect(() => writeCodexAnswer({ OUTCOME: 'success', MESSAGE: JSON.stringify(answer) })).toThrow(
      'GITHUB_OUTPUT',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MODE=codex runs the Codex reader from the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mode-'))
  const output = join(dir, 'output')
  try {
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, 'second-eye-result.ts')], {
      env: { ...process.env, MODE: 'codex', OUTCOME: 'skipped', MESSAGE: '', GITHUB_OUTPUT: output },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(run.exitCode).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('codex=off\nreview=\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

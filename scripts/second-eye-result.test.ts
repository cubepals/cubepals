// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Review availability is proved from the final provider result, never from error text. */
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  rateLimited,
  reviewAvailability,
  TOO_MANY_REQUESTS,
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

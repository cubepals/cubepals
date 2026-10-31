// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Classifies a model's final result; only an explicit HTTP 429 makes review optional. */
import { appendFileSync, readFileSync } from 'node:fs'

/** HTTP 429 Too Many Requests, defined by RFC 6585 section 4. */
export const TOO_MANY_REQUESTS = 429

export function rateLimited(execution: unknown): boolean {
  if (!Array.isArray(execution)) return false
  const result = execution.findLast((message) => message?.type === 'result')
  return result?.is_error === true && result.api_error_status === TOO_MANY_REQUESTS
}

export function reviewAvailability(outcome: string, structured: string, execution: unknown): boolean {
  if (rateLimited(execution)) return false
  if (outcome !== 'success' || !structured.trim())
    throw new Error('Automated review failed or returned no structured result')
  return true
}

export function writeReviewAvailability(env: Record<string, string | undefined> = process.env): void {
  const execution = env.EXECUTION_FILE ? JSON.parse(readFileSync(env.EXECUTION_FILE, 'utf8')) : undefined
  const available = reviewAvailability(env.OUTCOME ?? '', env.STRUCTURED ?? '', execution)
  const output = env.GITHUB_OUTPUT
  if (!output) throw new Error('GITHUB_OUTPUT is not set')
  appendFileSync(output, `unavailable=${!available}\n`)
  if (!available) {
    const message = 'Automated review unavailable. Skipped for this commit.'
    console.warn(`::notice::${message}`)
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`)
  }
}

if (import.meta.main) writeReviewAvailability()

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads a reviewer's final result for second-eye.yml. Codex's answer stands only in the review's
 * shape, and anything else hands the review to Claude (MODE=codex). Of Claude's, only an explicit
 * HTTP 429 makes the review optional.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import type { Review } from './second-eye-comment.ts'

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

/** Codex's final message as a review, when the step succeeded and it is in the review's shape. */
export function codexReview(outcome: string, message: string): Review | undefined {
  if (outcome !== 'success') return undefined
  let answer: unknown
  try {
    answer = JSON.parse(message)
  } catch {
    return undefined
  }
  if (typeof answer !== 'object' || answer === null) return undefined
  const { verdict, files_reviewed, earlier, findings } = answer as Record<string, unknown>
  if (verdict !== 'merge' && verdict !== 'fix first') return undefined
  if (!Number.isInteger(files_reviewed) || !Array.isArray(earlier) || !Array.isArray(findings))
    return undefined
  return answer as Review
}

/**
 * Writes what became of Codex: `codex` is answered, failed (it ran and gave no review) or off (the
 * step didn't run: no key), and `review` is its answer on one line, or empty for Claude to review.
 */
export function writeCodexAnswer(env: Record<string, string | undefined> = process.env): void {
  const output = env.GITHUB_OUTPUT
  if (!output) throw new Error('GITHUB_OUTPUT is not set')
  const outcome = env.OUTCOME ?? ''
  const review = codexReview(outcome, env.MESSAGE ?? '')
  const codex = review ? 'answered' : outcome === 'skipped' || outcome === '' ? 'off' : 'failed'
  // JSON.stringify writes no line break, so the answer fits the one-line form.
  appendFileSync(output, `codex=${codex}\nreview=${review ? JSON.stringify(review) : ''}\n`)
  if (codex !== 'answered')
    console.warn(
      `::notice::${codex === 'off' ? "Codex isn't set up" : 'Codex gave no review'}. Claude reviews in its place.`,
    )
}

if (import.meta.main) {
  if (process.env.MODE === 'codex') writeCodexAnswer()
  else writeReviewAvailability()
}

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Codex's own GitHub review as the second eye's answer (second-eye.yml). Codex reviews pull
 * requests on the maintainer's Codex plan, on OpenAI's servers, when code review is on for this
 * repository in Codex's settings, and posts a GitHub review from its app's account. This waits for
 * that review of the commit the second eye is reviewing and turns it into the second eye's answer:
 * each line comment a finding (P0 high, P1 medium, anything else low), and the verdict "fix first"
 * when one is high or medium. When Codex hasn't reviewed the commit by the deadline, it answers
 * nothing, and Claude reviews in its place.
 *
 *   bun scripts/second-eye-codex.ts
 *
 * It reads REPO, PULL, SHA (the commit under review), WAIT_MINUTES and GH_TOKEN, and writes
 * `codex` (answered or silent), `url` (Codex's review) and `review` (the answer on one line, or
 * empty) to GITHUB_OUTPUT. A GitHub error while waiting counts as no review yet. It imports nothing
 * installed. Not for Claude's review, which the workflow runs with .github/second-eye.md.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { MINUTE_MS, SECOND_MS } from '../packages/contracts/src/durations.ts'
import { github } from './lib/pull-comment.ts'
import type { Finding, Origin, Review, Severity } from './second-eye-comment.ts'

/** The account Codex's GitHub reviews come from, as OpenAI's code review documentation shows it. */
export const CODEX_BOT = 'chatgpt-codex-connector[bot]'
/** How often GitHub is asked for the review while waiting. */
const POLL_MS = 30 * SECOND_MS

/** A pull request review, as GitHub's REST API gives it. */
export interface GitHubReview {
  id: number
  user: { login: string; type: string } | null
  commit_id: string
  html_url: string
}

/** A line comment of a review, as GitHub's REST API gives it. */
export interface GitHubReviewComment {
  path: string
  line: number | null
  original_line: number | null
  body: string
  in_reply_to_id?: number
}

/** The longest file, problem and why Claude's answers may have (.github/second-eye.schema.json). */
const MOST = (() => {
  const schema = JSON.parse(
    readFileSync(new URL('../.github/second-eye.schema.json', import.meta.url), 'utf8'),
  )
  const field = schema.properties.findings.items.properties
  return { file: field.file.maxLength, problem: field.problem.maxLength, why: field.why.maxLength } as {
    file: number
    problem: number
    why: number
  }
})()

/** Codex's latest review of `sha`, when its own account posted one. */
export const codexReviewOf = (reviews: GitHubReview[], sha: string): GitHubReview | undefined =>
  reviews.filter((r) => r.user?.login === CODEX_BOT && r.user.type === 'Bot' && r.commit_id === sha).at(-1)

/** Codex marks each line comment P0 (breaks something) or P1 (should be fixed). */
export function severityOf(body: string): Severity {
  if (/\bP0\b/.test(body)) return 'high'
  if (/\bP1\b/.test(body)) return 'medium'
  return 'low'
}

/** Codex's Markdown as plain lines: no images or badges, tags, emphasis or feedback prompt. */
function plainLines(body: string): string[] {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|__/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^Useful\? React with/i.test(line))
}

/** One of Codex's line comments as a finding: its first line the problem, the rest the why. */
export function findingOf(comment: GitHubReviewComment): Finding & { origin: Origin } {
  const [problem = "See Codex's review.", ...rest] = plainLines(comment.body)
  return {
    severity: severityOf(comment.body),
    origin: 'first',
    file: comment.path.slice(0, MOST.file),
    line: Math.max(1, comment.line ?? comment.original_line ?? 1),
    problem: problem.slice(0, MOST.problem),
    fix: '',
    why: rest.join(' ').slice(0, MOST.why),
  }
}

/** Codex's line comments (its replies aside) as the second eye's answer. */
export function codexAnswer(comments: GitHubReviewComment[]): Review {
  const findings = comments.filter((comment) => !comment.in_reply_to_id).map(findingOf)
  return {
    verdict: findings.some((finding) => finding.severity !== 'low') ? 'fix first' : 'merge',
    earlier: [],
    findings,
  }
}

/** Asks `look` until it finds something or `waitMs` has passed, POLL_MS apart. */
export async function waitFor<T>(
  look: () => Promise<T | undefined>,
  waitMs: number,
  clock = { now: Date.now, sleep: (ms: number) => Bun.sleep(ms) },
): Promise<T | undefined> {
  const deadline = clock.now() + waitMs
  for (;;) {
    const found = await look()
    if (found !== undefined) return found
    const left = deadline - clock.now()
    if (left <= 0) return undefined
    await clock.sleep(Math.min(POLL_MS, left))
  }
}

/** Every page of a GitHub list. */
async function all<T>(path: string): Promise<T[]> {
  const items: T[] = []
  for (let page = 1; ; page++) {
    const batch = (await (await github(`${path}?per_page=100&page=${page}`)).json()) as T[]
    items.push(...batch)
    if (batch.length < 100) return items
  }
}

const need = (env: Record<string, string | undefined>, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** Waits for Codex's review of SHA and writes what became of it to GITHUB_OUTPUT. */
export async function writeCodexAnswer(
  env: Record<string, string | undefined> = process.env,
  wait: typeof waitFor = waitFor,
): Promise<void> {
  const output = need(env, 'GITHUB_OUTPUT')
  const [repo, pull, sha] = [need(env, 'REPO'), need(env, 'PULL'), need(env, 'SHA')]
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('SHA is not a commit')
  const found = await wait(
    async () => {
      try {
        const review = codexReviewOf(await all<GitHubReview>(`repos/${repo}/pulls/${pull}/reviews`), sha)
        if (!review) return undefined
        const comments = await all<GitHubReviewComment>(
          `repos/${repo}/pulls/${pull}/reviews/${review.id}/comments`,
        )
        return { url: review.html_url, review: codexAnswer(comments) }
      } catch (error) {
        console.warn(
          `::warning::Looking for Codex's review failed: ${String(error).replace(/[\r\n]+/g, ' ')}`,
        )
        return undefined
      }
    },
    Math.max(0, Number(env.WAIT_MINUTES) || 0) * MINUTE_MS,
  )
  if (!found) {
    appendFileSync(output, 'codex=silent\nurl=\nreview=\n')
    console.warn("::notice::Codex didn't review this commit in time. Claude reviews in its place.")
    return
  }
  const url = /^https:\/\/github\.com\/[^\s]+$/.test(found.url) ? found.url : ''
  // JSON.stringify writes no line break, so the answer fits the one-line form.
  appendFileSync(output, `codex=answered\nurl=${url}\nreview=${JSON.stringify(found.review)}\n`)
}

if (import.meta.main) await writeCodexAnswer()

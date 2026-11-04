// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Codex's own GitHub review as the second eye's answer (second-eye.yml). Codex reviews pull
 * requests on the maintainer's Codex plan, on OpenAI's servers, when one is opened or marked ready
 * and when someone comments "@codex review" (agents do, after each push: AGENTS.md). Its app's
 * account keeps a summary comment whose hidden state says which commit it reviewed and whether it
 * found anything; with findings it also posts a GitHub review of line comments, and without any it
 * reacts 👍 and posts none. This waits for either answer about the commit the second eye is
 * reviewing, once the summary shows every review of that commit finished (code, and security when
 * it runs), and turns it into the second eye's answer: each line comment a finding (P0 high, P1
 * medium, anything else low), the verdict "fix first" when one is high or medium, and "merge" when
 * Codex finished the commit with no findings. When Codex hasn't answered for the commit by the
 * deadline, this answers nothing, and Claude reviews in its place.
 *
 *   bun scripts/second-eye-codex.ts
 *
 * It reads REPO, PULL, SHA (the commit under review), WAIT_MINUTES and GH_TOKEN, and writes
 * `codex` (answered or silent), `url` (Codex's review or summary) and `review` (the answer on one line, or
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

/** A pull request's conversation comment, as GitHub's REST API gives it. */
export interface GitHubComment {
  user: { login: string; type: string } | null
  body?: string
  html_url: string
}

/** One of the reviews Codex's summary comment tracks: its commit, whether it found anything, and whether it is done. */
interface ReviewState {
  commit_sha: string | null
  has_any_findings: boolean | null
  status: string | null
}

/** The hidden state in Codex's summary comment (`<!-- codex-review-state:v1 {…} -->`), as Codex writes it. */
export interface CodexState {
  code_review?: ReviewState
  security_review?: ReviewState
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

/** True for something Codex's own app account wrote, not a person or bot using its name. */
const byCodex = (item: { user: { login: string; type: string } | null }): boolean =>
  item.user?.login === CODEX_BOT && item.user.type === 'Bot'

/** Codex's reviews of `sha` (its code review and security review are separate), oldest first. */
export const codexReviewsOf = (reviews: GitHubReview[], sha: string): GitHubReview[] =>
  reviews.filter((review) => byCodex(review) && review.commit_id === sha)

/** Codex's summary comment and the state it keeps, when its own account wrote one. */
export function codexSummaryOf(comments: GitHubComment[]): { url: string; state: CodexState } | undefined {
  for (const comment of comments.filter(byCodex).reverse()) {
    // GitHub stores the braces as written; an HTML-escaped copy (&#123; &#125;) reads the same.
    const body = (comment.body ?? '').replaceAll('&#123;', '{').replaceAll('&#125;', '}')
    const match = /<!-- codex-review-state:v1 (\{.*?\}) -->/s.exec(body)
    if (!match) continue
    try {
      return { url: comment.html_url, state: JSON.parse(match[1] as string) as CodexState }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * What Codex's summary says about `sha`: every review of it finished, with findings or clean, or
 * not finished yet (undefined). Its code review must have finished on `sha` saying whether it found
 * anything, and a security review of `sha`, when one runs, must have finished too; until then line
 * reviews already posted aren't the answer. A finished security review leaves `has_any_findings`
 * empty when it reports nothing (Codex then reacts 👍), so only `true` counts as its findings.
 */
export function outcomeFor(state: CodexState, sha: string): 'findings' | 'clean' | undefined {
  const code = state.code_review
  if (code?.commit_sha !== sha || code.status !== 'completed' || code.has_any_findings == null)
    return undefined
  const security = state.security_review
  const here = security?.commit_sha === sha
  if (here && security.status !== 'completed') return undefined
  return code.has_any_findings || (here && security.has_any_findings === true) ? 'findings' : 'clean'
}

/**
 * Codex marks each line comment with a badge on its first line: P0 (breaks something), P1 (should
 * be fixed), P2 and below. Only that line is read, so a P2 whose text mentions a P1 stays low.
 */
export function severityOf(body: string): Severity {
  const first = body.trimStart().split('\n')[0] ?? ''
  const priority = /!\[P(\d) Badge\]/.exec(first)?.[1] ?? /\bP(\d)\b/.exec(first)?.[1]
  if (priority === '0') return 'high'
  if (priority === '1') return 'medium'
  return 'low'
}

/** `text` with every HTML tag gone, stripped until none is left, and no stray angle bracket. */
function withoutTags(text: string): string {
  let before: string
  let after = text
  // One pass leaves a tag split around another (<scr<b>ipt>), so it repeats until nothing changes.
  do {
    before = after
    after = before.replace(/<[^<>]*>/g, '')
  } while (after !== before)
  return after.replace(/[<>]/g, '')
}

/** Codex's Markdown as plain lines: no images or badges, tags, emphasis or feedback prompt. */
function plainLines(body: string): string[] {
  return withoutTags(body.replace(/!\[[^\]]*\]\([^)]*\)/g, ''))
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
        const summary = codexSummaryOf(await all<GitHubComment>(`repos/${repo}/issues/${pull}/comments`))
        const outcome = summary && outcomeFor(summary.state, sha)
        if (!summary || !outcome) return undefined
        if (outcome === 'clean') return { url: summary.url, review: codexAnswer([]) }
        // Findings: Codex's line reviews of this commit, once they're on the pull request.
        const reviews = codexReviewsOf(await all<GitHubReview>(`repos/${repo}/pulls/${pull}/reviews`), sha)
        if (!reviews.length) return undefined
        const comments: GitHubReviewComment[] = []
        for (const review of reviews)
          comments.push(
            ...(await all<GitHubReviewComment>(`repos/${repo}/pulls/${pull}/reviews/${review.id}/comments`)),
          )
        // Findings Codex didn't put on a line (in a review's body, say) can't be read as findings:
        // that is no answer, not a clean one, and Claude reviews.
        const answer = codexAnswer(comments)
        if (!answer.findings.length) return undefined
        return { url: reviews.at(-1)?.html_url ?? '', review: answer }
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

// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Codex's own GitHub review becomes the second eye's answer, or Claude reviews when none comes. */
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_BOT,
  codexAnswer,
  codexReviewsOf,
  codexSummaryOf,
  findingOf,
  finishedClean,
  type GitHubComment,
  type GitHubReview,
  type GitHubReviewComment,
  severityOf,
  waitFor,
  writeCodexAnswer,
} from './second-eye-codex.ts'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'
const schema = JSON.parse(readFileSync(new URL('../.github/second-eye.schema.json', import.meta.url), 'utf8'))
const limits = schema.properties.findings.items.properties

const review = (id: number, login: string, commit: string, type = 'Bot'): GitHubReview => ({
  id,
  user: { login, type },
  commit_id: commit,
  html_url: `https://github.com/cubepals/cubepals/pull/42#pullrequestreview-${id}`,
})

// The shape of a line comment in OpenAI's code review documentation.
const p1: GitHubReviewComment = {
  path: 'packages/agents/src/session.ts',
  line: 858,
  original_line: 858,
  body: '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Approving MCP tools never notifies the server**\n\nThe approve method only handles function tools.\n\nA branch like reject is needed.\n\nUseful? React with 👍 / 👎.',
}

test("only Codex's own account counts, on the commit under review", () => {
  const reviews = [
    review(1, CODEX_BOT, SHA),
    review(2, 'someone', SHA),
    review(3, CODEX_BOT, OTHER),
    review(4, CODEX_BOT, SHA, 'User'),
    review(5, CODEX_BOT, SHA),
  ]
  expect(codexReviewsOf(reviews, SHA).map((r) => r.id)).toEqual([1, 5])
  expect(codexReviewsOf(reviews.slice(1, 4), SHA)).toEqual([])
})

// Codex's summary comment as it wrote it on a pull request here, once the review was done.
const state = (code: object, security: object = { commit_sha: null, has_any_findings: null, status: null }) =>
  `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { has_unresolved_findings: false, ...code },
    security_review: { has_unresolved_findings: null, ...security },
  })} -->\n\n## Codex Review Summary\n`
const done = { commit_sha: SHA, has_any_findings: false, status: 'completed' }
const summary = (body: string, login = CODEX_BOT, type = 'Bot'): GitHubComment => ({
  user: { login, type },
  body,
  html_url: 'https://github.com/cubepals/cubepals/pull/42#issuecomment-7',
})

test("Codex's summary state is read only from its own account's comment", () => {
  expect(codexSummaryOf([summary(state(done))])).toEqual({
    url: 'https://github.com/cubepals/cubepals/pull/42#issuecomment-7',
    state: {
      code_review: { has_unresolved_findings: false, ...done },
      security_review: {
        has_unresolved_findings: null,
        commit_sha: null,
        has_any_findings: null,
        status: null,
      },
    },
  })
  expect(codexSummaryOf([summary(state(done), 'someone', 'User')])).toBeUndefined()
  expect(codexSummaryOf([summary('<!-- codex-review-state:v1 {nope} -->')])).toBeUndefined()
  expect(codexSummaryOf([summary('Thanks!')])).toBeUndefined()
  const escaped = state(done).replace(/(?<=v1 )[^]*?(?= -->)/, (json) =>
    json.replaceAll('{', '&#123;').replaceAll('}', '&#125;'),
  )
  expect(escaped).toContain('&#123;')
  expect(codexSummaryOf([summary(escaped)])?.state.code_review).toMatchObject(done)
})

test('a finished review with no findings of this commit is clean, and nothing else is', () => {
  const read = (body: string) => codexSummaryOf([summary(body)])?.state ?? {}
  expect(finishedClean(read(state(done)), SHA)).toBe(true)
  expect(finishedClean(read(state({ ...done, status: 'running', has_any_findings: null })), SHA)).toBe(false)
  expect(finishedClean(read(state({ ...done, has_any_findings: true })), SHA)).toBe(false)
  expect(finishedClean(read(state({ ...done, commit_sha: OTHER })), SHA)).toBe(false)
  expect(
    finishedClean(read(state(done, { commit_sha: SHA, has_any_findings: null, status: 'running' })), SHA),
  ).toBe(false)
  expect(
    finishedClean(read(state(done, { commit_sha: SHA, has_any_findings: true, status: 'completed' })), SHA),
  ).toBe(false)
  expect(
    finishedClean(read(state(done, { commit_sha: SHA, has_any_findings: false, status: 'completed' })), SHA),
  ).toBe(true)
  expect(finishedClean({}, SHA)).toBe(false)
})

test('P0 is high, P1 medium, anything else low', () => {
  expect(severityOf('![P0 Badge](x) Data loss')).toBe('high')
  expect(severityOf(p1.body)).toBe('medium')
  expect(severityOf('A note with no badge')).toBe('low')
  expect(severityOf('Uses AP1 internally')).toBe('low')
})

test('a line comment becomes a finding: the title the problem, the rest the why', () => {
  expect(findingOf(p1)).toEqual({
    severity: 'medium',
    origin: 'first',
    file: 'packages/agents/src/session.ts',
    line: 858,
    problem: 'Approving MCP tools never notifies the server',
    fix: '',
    why: 'The approve method only handles function tools. A branch like reject is needed.',
  })
  expect(findingOf({ ...p1, line: null, original_line: 12 }).line).toBe(12)
  expect(findingOf({ ...p1, line: null, original_line: null }).line).toBe(1)
  expect(findingOf({ ...p1, body: '' }).problem).toBe("See Codex's review.")
  const nested = findingOf({ ...p1, body: 'Breaks <scr<b>ipt>alert(1)</script> here\n<<img src=x>>' })
  expect(nested.problem).toBe('Breaks alert(1) here')
  expect(JSON.stringify(nested)).not.toMatch(/[<>]/)
})

test("a finding keeps to the lengths Claude's answers have", () => {
  const long = findingOf({ ...p1, path: 'a/'.repeat(500), body: `${'x'.repeat(900)}\n${'y'.repeat(900)}` })
  expect(long.file.length).toBe(limits.file.maxLength)
  expect(long.problem.length).toBe(limits.problem.maxLength)
  expect(long.why?.length).toBe(limits.why.maxLength)
})

test('the verdict is fix first on a P0 or P1, and replies are not findings', () => {
  expect(codexAnswer([p1])).toMatchObject({ verdict: 'fix first', earlier: [] })
  expect(codexAnswer([])).toEqual({ verdict: 'merge', earlier: [], findings: [] })
  expect(codexAnswer([{ ...p1, body: 'A note' }]).verdict).toBe('merge')
  expect(codexAnswer([p1, { ...p1, in_reply_to_id: 7 }]).findings).toHaveLength(1)
})

test('waiting asks until found, at most every 30 seconds, and gives up at the deadline', async () => {
  let now = 0
  const sleeps: number[] = []
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      now += ms
    },
  }
  let asked = 0
  expect(await waitFor(async () => (++asked === 3 ? 'found' : undefined), 120_000, clock)).toBe('found')
  expect(sleeps).toEqual([30_000, 30_000])
  now = 0
  sleeps.length = 0
  expect(await waitFor(async () => undefined, 45_000, clock)).toBeUndefined()
  expect(sleeps).toEqual([30_000, 15_000])
  expect(await waitFor(async () => 'now', 0, clock)).toBe('now')
})

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('the answer, the silence and a GitHub error are written as the workflow reads them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'second-eye-codex-'))
  const output = join(dir, 'output')
  const env = {
    GITHUB_OUTPUT: output,
    GH_TOKEN: 't',
    REPO: 'cubepals/cubepals',
    PULL: '42',
    SHA,
    WAIT_MINUTES: '0',
  }
  let reviews: GitHubReview[] = []
  let comments: GitHubComment[] = []
  let failing = false
  spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0]) => {
        if (failing) return new Response(null, { status: 502 })
        const path = String(url)
        if (path.includes('/reviews/5/comments')) return Response.json([p1])
        if (path.includes('/reviews/6/comments')) return Response.json([{ ...p1, path: 'b.ts' }])
        if (path.includes('/reviews?')) return Response.json(reviews)
        if (path.includes('/issues/42/comments?')) return Response.json(comments)
        throw new Error(`Unexpected request: ${path}`)
      },
      { preconnect: originalFetch.preconnect },
    ),
  )
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await writeCodexAnswer(env)
    expect(readFileSync(output, 'utf8')).toBe('codex=silent\nurl=\nreview=\n')
    rmSync(output)
    comments = [summary(state({ ...done, status: 'running', has_any_findings: null }))]
    await writeCodexAnswer(env)
    expect(readFileSync(output, 'utf8')).toBe('codex=silent\nurl=\nreview=\n')
    rmSync(output)
    comments = [summary(state(done))]
    await writeCodexAnswer(env)
    expect(readFileSync(output, 'utf8')).toBe(
      `codex=answered\nurl=https://github.com/cubepals/cubepals/pull/42#issuecomment-7\nreview=${JSON.stringify(codexAnswer([]))}\n`,
    )
    rmSync(output)
    reviews = [review(5, CODEX_BOT, SHA), review(6, CODEX_BOT, SHA)]
    await writeCodexAnswer(env)
    expect(readFileSync(output, 'utf8')).toContain(`url=${reviews[1]?.html_url}`)
    expect(readFileSync(output, 'utf8')).toContain('"file":"b.ts"')
    rmSync(output)
    reviews = [review(5, CODEX_BOT, SHA)]
    await writeCodexAnswer(env)
    const [codex, url, answer] = readFileSync(output, 'utf8').trimEnd().split('\n')
    expect([codex, url]).toEqual(['codex=answered', `url=${reviews[0]?.html_url}`])
    expect(JSON.parse(answer?.replace('review=', '') ?? '')).toEqual(codexAnswer([p1]))
    rmSync(output)
    reviews = [{ ...review(5, CODEX_BOT, SHA), html_url: 'javascript:alert(1)' }]
    await writeCodexAnswer(env)
    expect(readFileSync(output, 'utf8')).toContain('url=\n')
    rmSync(output)
    failing = true
    await writeCodexAnswer(env)
    expect(readFileSync(output, 'utf8')).toBe('codex=silent\nurl=\nreview=\n')
    expect(
      warn.mock.calls.some(([line]) =>
        String(line).startsWith("::warning::Looking for Codex's review failed"),
      ),
    ).toBe(true)
    await expect(writeCodexAnswer({ ...env, SHA: 'main' })).rejects.toThrow('SHA')
    await expect(writeCodexAnswer({ ...env, GITHUB_OUTPUT: '' })).rejects.toThrow('GITHUB_OUTPUT')
  } finally {
    warn.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})

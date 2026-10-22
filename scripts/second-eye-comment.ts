// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The second reviewer's one comment on a pull request (second-eye.yml): the findings Claude
 * returned as JSON, written in one fixed shape that says it is an AI review: a heading, the
 * verdict, what was reviewed, what it looked at and which model, a row a finding with the
 * reasoning folded away, and a footer saying how to run it again. Findings are grouped by
 * severity, high first, with no cap on how many. It is edited in place on each run instead of
 * written again, and the pull request carries one label for the verdict.
 *
 * It shows how many of the changed files the reviewer read, so a partial pass is visible. On a
 * re-review it also says what became of the earlier findings (fixed, no longer applies, still
 * open) and splits the rest into new (on code changed since) and missed before. The comment ends
 * with a data block of the findings that stand, which the next run reads as the earlier review.
 *
 * While the review stands on a commit the pull request has moved past, a line at the top says so
 * (a new review is running, waits for the draft to be ready, or didn't finish) and the verdict's
 * label is off, so nobody merges on an old verdict.
 *
 *   bun scripts/second-eye-comment.ts
 *   NOTICE=running|draft|failed bun scripts/second-eye-comment.ts
 *
 * It reads REVIEW (the action's structured output), REVIEWED (the commit and its counts, as the
 * review job read them), PREVIOUS (the earlier review's findings, when there was one), MODEL, REPO, PULL and GH_TOKEN from the environment the workflow gives
 * it, and what the reviewer looks at from .github/second-eye.md. With NOTICE it writes only the
 * line at the top and needs no review. It needs no installed package.
 * Not for what the reviewer looks for or how it judges: .github/second-eye.md says that.
 */
import { readFileSync } from 'node:fs'
import { github, keepComment, ourComment } from './lib/pull-comment.ts'

export type Severity = 'high' | 'medium' | 'low'

export interface Finding {
  severity: Severity
  file: string
  line: number
  problem: string
  fix: string
  /** How the reviewer knows: the path it traced. Older answers have none. */
  why?: string
}

/** Where a finding came from: a first review, or a re-review's carried-over, new or missed one. */
export type Origin = 'first' | 'open' | 'new' | 'missed'

/** What became of an earlier finding that is no longer open. */
export interface Settled {
  /** The earlier finding's number, from 1, in the order the earlier review listed them. */
  number: number
  status: 'fixed' | 'gone'
  note?: string
}

export interface Review {
  verdict: 'merge' | 'fix first'
  /** How many of the changed files the reviewer read. */
  files_reviewed?: number
  earlier?: Settled[]
  findings: (Finding & { origin?: Origin })[]
}

/** The findings the comment ends with and the next review starts from. */
export interface Previous {
  sha: string
  findings: Pick<Finding, 'severity' | 'file' | 'line' | 'problem'>[]
}

/** What the comment says about the run, beside Claude's answer. */
export interface Run {
  repo: string
  pull: number | string
  /** The pull request's head when the review read it, and its counts. */
  sha: string
  files: number
  additions: number
  deletions: number
  model: string
  runUrl: string
  /** What .github/second-eye.md tells the reviewer to look for. */
  areas: string[]
  /** True when the run edits a comment an earlier run wrote. */
  updating: boolean
  /** The review before this one, when there was one. */
  previous?: Previous
}

/** The comment's first line, which finds it again. */
export const MARKER = '<!-- second-eye -->'
/** The data block that ends the comment: the findings that stand, for the next review. */
const DATA = 'second-eye-data:'
/** How much of each problem is kept when a review is far too long for one comment. */
const SHORT = 100
/** GitHub refuses a comment past 65536 characters; past this the folded reasons are left out. */
const MOST_CHARACTERS = 60000

/** The labels a pull request carries for the verdict: one, and never both. */
export const LABELS = { merge: 'review/ai-merge', 'fix first': 'review/ai-fix-first' } as const
/** The label that asks for a review, and has each new push reviewed again. */
export const ASKED = 'needs-second-eye'

/**
 * Why the review on the pull request isn't for its head: a new review is running, the new commits
 * are a draft's, the new review didn't finish, or the head moved while it ran.
 */
export type Notice = 'running' | 'draft' | 'failed' | 'moved'

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
/** A severity's heading over its table. */
const HEADING: Record<Severity, string> = { high: '🔴 High', medium: '🟠 Medium', low: '🟡 Low' }
/** What a re-review says of a finding in its row. */
const SINCE: Record<Origin, string> = {
  first: '',
  open: 'Still open',
  new: 'New, in code changed since',
  missed: 'Missed before',
}

/** The verdict's badge: an emoji, which renders everywhere and fetches nothing. */
const BADGE = { merge: '✅', 'fix first': '⚠️' } as const

/** Claude's text on one line, with no code spans to break out of and nobody mentioned. */
const plain = (text: unknown): string =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .replaceAll('`', "'")
    .replaceAll('@', '@​')
    .trim()

/** Claude's text in a table cell or HTML block: no column break and no tag of its own. */
const cell = (text: unknown): string => plain(text).replaceAll('|', '\\|').replaceAll('<', '&lt;')

const short = (sha: string): string => sha.slice(0, 7)

const commitLink = (run: Pick<Run, 'repo' | 'sha'>): string =>
  /^[0-9a-f]{40}$/.test(run.sha)
    ? `[\`${short(run.sha)}\`](https://github.com/${run.repo}/commit/${run.sha})`
    : '`unknown`'

/** The file and line, linked to that line at the reviewed commit. */
function where(run: Run, finding: Finding): string {
  const line = Math.max(0, Math.trunc(Number(finding.line) || 0))
  const label = `\`${plain(finding.file).replaceAll('|', '\\|')}${line ? `:${line}` : ''}\``
  if (!/^[0-9a-f]{40}$/.test(run.sha)) return label
  const path = plain(finding.file)
    .split('/')
    .map((part) => encodeURIComponent(part).replaceAll('(', '%28').replaceAll(')', '%29'))
    .join('/')
  return `[${label}](https://github.com/${run.repo}/blob/${run.sha}/${path}${line ? `#L${line}` : ''})`
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The findings written, most severe first, and the verdict they leave. */
function judged(review: Review): { verdict: Review['verdict']; findings: Review['findings'] } {
  const findings = (review.findings ?? [])
    .filter((finding) => finding.severity in RANK)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity])
  return { verdict: findings.length && review.verdict !== 'merge' ? 'fix first' : 'merge', findings }
}

/** The label the pull request carries for this review. */
export const labelFor = (review: Review): string => LABELS[judged(review).verdict]

/** What the reviewer looks for: each bullet's name under "What counts" in .github/second-eye.md. */
export function lookedAt(rules: string): string[] {
  const section = rules.split(/^## /m).find((part) => part.startsWith('What counts')) ?? ''
  return [...section.matchAll(/^- ([^:\n]+):/gm)].map((match) => (match[1] as string).trim())
}

/** How many of the changed files were read, with a warning when that is not all of them. */
function filesRead(review: Review, run: Run): string {
  const total = count(run.files, 'file', 'files')
  const read = review.files_reviewed
  if (read === undefined) return `${total}, +${run.additions} −${run.deletions} lines`
  const done = Math.min(Math.max(0, Math.trunc(Number(read) || 0)), run.files)
  return `${total}, +${run.additions} −${run.deletions} lines · ${
    done >= run.files ? `read all ${run.files}` : `⚠️ read ${done} of ${run.files}`
  }`
}

/** What became of the earlier review's findings, and how the rest split, in a line or two. */
function sinceLine(review: Review, previous: Previous): string[] {
  const settled = [...new Map((review.earlier ?? []).map((e) => [e.number, e])).values()].filter(
    (e) => previous.findings[e.number - 1],
  )
  const origin = (kind: Origin) => (review.findings ?? []).filter((f) => f.origin === kind).length
  const part = (n: number, text: string) => (n ? [`${n} ${text}`] : [])
  const earlier = [
    ...part(settled.filter((e) => e.status === 'fixed').length, 'fixed'),
    ...part(settled.filter((e) => e.status === 'gone').length, 'no longer apply'),
    ...part(origin('open'), 'still open'),
  ]
  const added = [
    ...part(origin('new'), 'new, in code changed since'),
    ...part(origin('missed'), 'missed before'),
  ]
  const lost = previous.findings.length - settled.length - origin('open')
  return [
    `**Since the last review.** Earlier: ${count(previous.findings.length, 'finding', 'findings')}${
      earlier.length || lost > 0
        ? ` (${[...earlier, ...part(Math.max(lost, 0), 'not accounted for')].join(', ')})`
        : ''
    }. Now: ${added.length ? added.join(', ') : 'nothing new'}.`,
    '',
  ]
}

/** The earlier findings that are fixed or no longer apply, folded away. */
function settledDetails(review: Review, previous: Previous): string[] {
  const rows = (review.earlier ?? []).flatMap((e) => {
    const was = previous.findings[e.number - 1]
    if (!was) return []
    const note = e.note ? ` ${cell(e.note)}` : ''
    return [`- ${e.status === 'fixed' ? 'Fixed' : 'No longer applies'}: ${cell(was.problem)}${note}`]
  })
  return rows.length
    ? [
        '<details>',
        `<summary>Earlier findings that are settled (${rows.length})</summary>`,
        '',
        ...rows,
        '',
        '</details>',
        '',
      ]
    : []
}

/** The data block the next review starts from: the findings that stand, on this commit. */
function dataBlock(run: Run, findings: Review['findings']): string {
  const kept = findings.map(({ severity, file, line, problem }) => ({ severity, file, line, problem }))
  return `<!-- ${DATA}${Buffer.from(JSON.stringify({ sha: run.sha, findings: kept })).toString('base64')} -->`
}

/** The comment's text, in GitHub's Markdown. */
export function secondEyeComment(review: Review, run: Run): string {
  const { verdict, findings } = judged(review)
  const areas = run.areas.map((area) => area.replaceAll('`', '')).join(', ')
  const summary = [
    ['Reviewed', `${commitLink(run)} · ${filesRead(review, run)}`],
    ['Looked at', areas ? areas.charAt(0).toUpperCase() + areas.slice(1) : 'Unknown'],
    ['Model', `${run.model ? `\`${plain(run.model)}\`` : 'Unknown'} · [Workflow run](${run.runUrl})`],
  ]
  const groups = (Object.keys(RANK) as Severity[])
    .map((severity) => ({ severity, found: findings.filter((finding) => finding.severity === severity) }))
    .filter((group) => group.found.length)
  const head = run.previous
    ? ['| Where | Problem | Since the last review |', '| --- | --- | --- |']
    : ['| Where | Problem |', '| --- | --- |']
  const why = findings.map(
    (finding, i) =>
      `${i + 1}. ${where(run, finding)}${finding.why ? ` ${cell(finding.why)}` : ''} **Fix:** ${cell(finding.fix)}`,
  )
  // Too long for a comment: first the folded reasons go, then each problem is cut short.
  const reasons = (stage: 0 | 1 | 2): string[] => {
    if (!findings.length) return []
    if (stage === 0)
      return ['<details>', '<summary>Why, and the fix</summary>', '', ...why, '', '</details>', '']
    return ['_The reasons and fixes are left out: the review is too long for one comment._', '']
  }
  const problem = (text: string, stage: 0 | 1 | 2): string =>
    stage === 2 ? plain(text).slice(0, SHORT) : text
  const lines = (stage: 0 | 1 | 2) => [
    MARKER,
    ...(run.updating ? [`<sub>Updated for ${commitLink(run)}</sub>`, ''] : []),
    '### 🤖 Second eye · AI review by Claude',
    '',
    `${BADGE[verdict]} **Verdict: ${verdict === 'merge' ? 'Merge' : 'Fix first'}.** ${
      findings.length ? `${count(findings.length, 'finding', 'findings')}.` : 'No findings.'
    }`,
    '',
    '| Run | Details |',
    '| :--- | :--- |',
    ...summary.map(([name, value]) => `| **${name}** | ${value} |`),
    '',
    ...(run.previous ? sinceLine(review, run.previous) : []),
    ...groups.flatMap(({ severity, found }) => [
      `#### ${HEADING[severity]} (${found.length})`,
      '',
      ...head,
      ...found.map(
        (finding) =>
          `| ${where(run, finding)} | ${cell(problem(finding.problem, stage))} |${run.previous ? ` ${SINCE[finding.origin ?? 'first']} |` : ''}`,
      ),
      '',
    ]),
    ...reasons(stage),
    ...(run.previous && stage < 2 ? settledDetails(review, run.previous) : []),
    `<sub>An automated review by Claude, not a person. The verdict advises; on a sensitive change the Second eye gate also waits for a finished review. Re-run: \`gh workflow run second-eye.yml -f pr=${run.pull}\`</sub>`,
    dataBlock(
      run,
      stage === 2
        ? findings.map((finding) => ({ ...finding, problem: problem(finding.problem, stage) }))
        : findings,
    ),
  ]
  for (const stage of [0, 1] as const) {
    const body = lines(stage).join('\n')
    if (body.length <= MOST_CHARACTERS) return body
  }
  return lines(2).join('\n')
}

/** The commit a comment's review is for: the first commit it links to below any notice. */
export const reviewedIn = (body: string): string | undefined =>
  /\/commit\/([0-9a-f]{40})\)/.exec(withNotice(body))?.[1]

/** The line at the top that says the review isn't for `head`, the pull request's head now. */
export function noticeLine(notice: Notice, repo: string, reviewed: string | undefined, head: string): string {
  const commit = commitLink({ repo, sha: head })
  const text = {
    running: `A new review of ${commit} is running.`,
    draft: 'A new review starts when the pull request is ready for review.',
    failed: `The new review of ${commit} didn't finish.`,
    moved: `The pull request is now at ${commit}.`,
  }[notice]
  const badge = notice === 'running' ? '⏳' : notice === 'draft' ? '⏸️' : '⚠️'
  return `> ${badge} ${reviewed === head ? `**${text}**` : `**Reviewed an older commit.** ${text}`}`
}

/** `body` with `line` at its top, in place of any line an earlier notice left; none, with no line. */
export function withNotice(body: string, line?: string): string {
  const lines = body.split('\n')
  if (lines[0] === MARKER) lines.shift()
  if (lines[0]?.startsWith('> ')) lines.splice(0, lines[1] === '' ? 2 : 1)
  return [MARKER, ...(line ? [line, ''] : []), ...lines].join('\n')
}

/** The pull request's head commit and labels as they are now. */
async function pullNow(repo: string, pull: string): Promise<{ head: string; labels: string[] }> {
  const response = await github(`repos/${repo}/pulls/${pull}`)
  const now = (await response.json()) as { head: { sha: string }; labels: { name: string }[] }
  return { head: now.head.sha, labels: now.labels.map((l) => l.name) }
}

/**
 * Puts `want` on the pull request and takes every other verdict label off. With none, it takes
 * them all off and puts needs-second-eye on, so a review asked for by a comment follows the next
 * push too.
 */
async function label(repo: string, pull: string, carried: string[], want?: string): Promise<void> {
  const add = want ?? (carried.includes(ASKED) ? undefined : ASKED)
  if (add)
    await github(`repos/${repo}/issues/${pull}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [add] }),
    })
  for (const other of Object.values(LABELS)) {
    if (other === want || !carried.includes(other)) continue
    await github(`repos/${repo}/issues/${pull}/labels/${encodeURIComponent(other)}`, { method: 'DELETE' })
  }
}

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** Says at the top of the comment that it isn't for the head, and takes the verdict's label off. */
async function markStale(repo: string, pull: string, notice: Notice): Promise<void> {
  const now = await pullNow(repo, pull)
  const comment = await ourComment(repo, pull, MARKER)
  if (comment)
    await github(`repos/${repo}/issues/comments/${comment.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        body: withNotice(comment.body, noticeLine(notice, repo, reviewedIn(comment.body), now.head)),
      }),
    })
  await label(repo, pull, now.labels)
}

async function writeReview(repo: string, pull: string): Promise<void> {
  const review = JSON.parse(need('REVIEW')) as Review
  const earlier = process.env.PREVIOUS ? (JSON.parse(process.env.PREVIOUS) as Previous) : undefined
  const reviewed = JSON.parse(need('REVIEWED')) as {
    sha: string
    files: number
    additions: number
    deletions: number
  }
  const run: Omit<Run, 'updating'> = {
    repo,
    pull,
    sha: String(reviewed.sha),
    files: Number(reviewed.files) || 0,
    additions: Number(reviewed.additions) || 0,
    deletions: Number(reviewed.deletions) || 0,
    model: process.env.MODEL ?? '',
    runUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${need('GITHUB_RUN_ID')}`,
    areas: lookedAt(readFileSync(new URL('../.github/second-eye.md', import.meta.url), 'utf8')),
    previous: earlier,
  }
  // A push the workflow didn't review again (a draft's, or anyone else's) moved the head on.
  const now = await pullNow(repo, pull)
  const moved = now.head !== run.sha ? noticeLine('moved', repo, run.sha, now.head) : undefined
  await keepComment(repo, pull, MARKER, (updating) =>
    withNotice(secondEyeComment(review, { ...run, updating }), moved),
  )
  await label(repo, pull, now.labels, moved ? undefined : labelFor(review))
}

if (import.meta.main) {
  const notice = process.env.NOTICE as Notice | undefined
  if (notice && !['running', 'draft', 'failed'].includes(notice)) throw new Error(`NOTICE is ${notice}`)
  if (notice) await markStale(need('REPO'), need('PULL'), notice)
  else await writeReview(need('REPO'), need('PULL'))
}

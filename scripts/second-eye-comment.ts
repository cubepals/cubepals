// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The second reviewer's one comment on a pull request (second-eye.yml): the findings Claude
 * returned as JSON, written in one fixed shape that says it is an AI review: a heading, the
 * verdict, what was reviewed, what it looked at and which model, a row a finding with the
 * reasoning folded away, and a footer saying how to run it again. It is edited in place on each
 * run instead of written again, and the pull request carries one label for the verdict.
 *
 * While the review stands on a commit the pull request has moved past, a line at the top says so
 * (a new review is running, waits for the draft to be ready, or didn't finish) and the verdict's
 * label is off, so nobody merges on an old verdict.
 *
 *   bun scripts/second-eye-comment.ts
 *   NOTICE=running|draft|failed bun scripts/second-eye-comment.ts
 *
 * It reads REVIEW (the action's structured output), REVIEWED (the commit and its counts, as the
 * review job read them), MODEL, REPO, PULL and GH_TOKEN from the environment the workflow gives
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

export interface Review {
  verdict: 'merge' | 'fix first'
  findings: Finding[]
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
}

/** The comment's first line, which finds it again. */
export const MARKER = '<!-- second-eye -->'
/** At most this many findings are written, most severe first. */
const MOST_FINDINGS = 8

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
/** A severity's tag, kept on one line in its cell. */
const TAG: Record<Severity, string> = { high: '🔴&nbsp;High', medium: '🟠&nbsp;Medium', low: '🟡&nbsp;Low' }

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
function judged(review: Review): { verdict: Review['verdict']; findings: Finding[] } {
  const findings = (review.findings ?? [])
    .filter((finding) => finding.severity in RANK)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity])
    .slice(0, MOST_FINDINGS)
  return { verdict: findings.length && review.verdict !== 'merge' ? 'fix first' : 'merge', findings }
}

/** The label the pull request carries for this review. */
export const labelFor = (review: Review): string => LABELS[judged(review).verdict]

/** What the reviewer looks for: each bullet's name under "What counts" in .github/second-eye.md. */
export function lookedAt(rules: string): string[] {
  const section = rules.split(/^## /m).find((part) => part.startsWith('What counts')) ?? ''
  return [...section.matchAll(/^- ([^:\n]+):/gm)].map((match) => (match[1] as string).trim())
}

/** The comment's text, in GitHub's Markdown. */
export function secondEyeComment(review: Review, run: Run): string {
  const { verdict, findings } = judged(review)
  const areas = run.areas.map((area) => area.replaceAll('`', '')).join(', ')
  const summary = [
    [
      'Reviewed',
      `${commitLink(run)} · ${count(run.files, 'file', 'files')}, +${run.additions} −${run.deletions} lines`,
    ],
    ['Looked at', areas ? areas.charAt(0).toUpperCase() + areas.slice(1) : 'Unknown'],
    ['Model', `${run.model ? `\`${plain(run.model)}\`` : 'Unknown'} · [Workflow run](${run.runUrl})`],
  ]
  return [
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
    ...(findings.length
      ? [
          '| Severity | Where | Problem |',
          '| --- | --- | --- |',
          ...findings.map(
            (finding) => `| ${TAG[finding.severity]} | ${where(run, finding)} | ${cell(finding.problem)} |`,
          ),
          '',
          '<details>',
          '<summary>Why, and the fix</summary>',
          '',
          ...findings.map(
            (finding, i) =>
              `${i + 1}. ${where(run, finding)}${finding.why ? ` ${cell(finding.why)}` : ''} **Fix:** ${cell(finding.fix)}`,
          ),
          '',
          '</details>',
          '',
        ]
      : []),
    `<sub>An automated review by Claude, not a person. It advises and doesn't block the merge. Re-run: \`gh workflow run second-eye.yml -f pr=${run.pull}\`</sub>`,
  ].join('\n')
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

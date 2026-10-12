// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one comment on a pull request that reports its CI run (ci.yml): running, then passed or
 * failed, with a row per part of the run, its tests' counts, and every failed test with the first
 * lines of its error.
 *
 *   bun scripts/ci-comment.ts
 *
 * ci-comment.yml runs it from the base branch on each of CI's runs, with GH_TOKEN, REPO and
 * RUN_ID, and once the run is done, JUNIT: the directory its test groups' JUnit reports were
 * downloaded to, one directory per artifact. It reads the run and its jobs from GitHub's API,
 * finds the pull request from the run's head, and edits the comment it wrote before, found by its
 * marker. It needs no installed package. Not for judging the run: ci.yml's `check` does that, and
 * this comment only reports it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MINUTE_S, SECOND_MS } from '../packages/contracts/src/durations.ts'
import { github, keepComment } from './lib/pull-comment.ts'

/** One test that failed, by where it is and what it said. */
export interface Failure {
  file: string
  name: string
  error: string
}

/** What one test group's JUnit report counts. */
export interface Report {
  passed: number
  failed: number
  skipped: number
  failures: Failure[]
}

/** One of the run's jobs, as GitHub's jobs API gives it. */
export interface Job {
  name: string
  status: string
  conclusion: string | null
  html_url: string | null
  started_at: string | null
  completed_at: string | null
}

export interface Run {
  repo: string
  sha: string
  url: string
  /** The run's own conclusion once it is done; null while it runs. */
  conclusion: string | null
  jobs: Job[]
  /** Each test group's report, by its group's name as ci.yml's matrix gives it. */
  reports: Map<string, Report>
  now: Date
}

/** The comment's first line, which finds it again. */
export const MARKER = '<!-- ci-results -->'
const BRAND = 'https://raw.githubusercontent.com/cubepals/cubepals/main/brand/png'
/** ci.yml's jobs that are no part of their own: what changed, and the aggregate of the rest. */
const UNLISTED = ['Find what changed', 'check']
const TESTS = 'Tests, '
/** The artifact each test group's report is uploaded as is this followed by the group's name. */
const ARTIFACT = 'junit-'
/** At most this many failed tests are listed, and this many lines of each one's error. */
const MOST_FAILURES = 20
const ERROR_LINES = 10

const STATE: Record<string, string> = {
  running: '⏳ Running',
  success: '✅ Passed',
  failure: '❌ Failed',
  cancelled: '⚪ Cancelled',
  timed_out: '❌ Timed out',
}

const RESULT: Record<string, string> = {
  success: '✅ Passed',
  failure: '❌ Failed',
  cancelled: '⚪ Cancelled',
  timed_out: '❌ Timed out',
  skipped: '⏭️ Skipped: nothing it covers changed',
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

const unescapeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, entity: string) =>
    entity[0] !== '#'
      ? (XML_ENTITIES[entity] ?? '')
      : String.fromCodePoint(
          Number.parseInt(entity.slice(entity[1] === 'x' ? 2 : 1), entity[1] === 'x' ? 16 : 10),
        ),
  )

const attribute = (tag: string, name: string): string => {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
  return value === undefined ? '' : unescapeXml(value)
}

/** Counts one testcase element, by its attributes and what it holds, under its describe blocks. */
function record(report: Report, describes: string[], testcase: string, body: string): void {
  if (/<skipped\b/.test(body)) {
    report.skipped++
    return
  }
  const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body)
  if (!failure) {
    report.passed++
    return
  }
  report.failed++
  report.failures.push({
    file: attribute(testcase, 'file'),
    name: [...describes, attribute(testcase, 'name')].join(' › '),
    error: failure[3] === undefined ? attribute(failure[2] ?? '', 'message') : unescapeXml(failure[3]),
  })
}

/**
 * The counts and failures in one of bun's JUnit reports. Its outer testsuites are files, those
 * inside them are `describe` blocks, so a test's name is theirs joined with its own. A file that
 * fails before any test runs is in no report: its job's result says it.
 */
export function parseJunit(xml: string): Report {
  const report: Report = { passed: 0, failed: 0, skipped: 0, failures: [] }
  const suites: string[] = []
  const tags = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
  for (const [, suite, empty, testcase, body = ''] of xml.matchAll(tags)) {
    if (testcase !== undefined) record(report, suites.slice(1), testcase, body)
    else if (suite === undefined) suites.pop()
    else if (!empty) suites.push(attribute(suite, 'name'))
  }
  return report
}

/** Text that stays text in a Markdown table and in HTML. */
const plain = (text: string): string =>
  text
    .replace(/[<>&]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp' }[c]};`)
    .replace(/[|\\`*_[\]]/g, '\\$&')

/** `text` in a fenced block no line of it can close. */
const fenced = (text: string): string => {
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)))
  return [fence, text, fence].join('\n')
}

const count = (n: number): string => n.toLocaleString('en-US')

/** How long a job took, as "2m 41s"; nothing for one that hasn't finished. */
function took(job: Job): string {
  if (!job.started_at || !job.completed_at) return ''
  const seconds = Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / SECOND_MS)
  if (seconds < 0) return ''
  return seconds < MINUTE_S ? `${seconds}s` : `${Math.floor(seconds / MINUTE_S)}m ${seconds % MINUTE_S}s`
}

/** A test group's name, from its job's; a skipped matrix job keeps its name unexpanded. */
const groupOf = (job: Job): string | undefined =>
  job.name.startsWith(TESTS) && !job.name.includes('${{') ? job.name.slice(TESTS.length) : undefined

function result(job: Job): string {
  if (job.status !== 'completed') return job.status === 'in_progress' ? '⏳ Running' : '⏳ Waiting'
  return RESULT[job.conclusion ?? ''] ?? `❔ ${job.conclusion ?? 'Unknown'}`
}

function row(job: Job, report: Report | undefined): string {
  const name = job.name.replace(/, \$\{\{.*\}\}$/, '')
  const part = job.html_url ? `[${plain(name)}](${job.html_url})` : plain(name)
  const counts = report ? [count(report.passed), count(report.failed), count(report.skipped)] : ['', '', '']
  return `| ${[part, result(job), ...counts, took(job)].join(' | ')} |`
}

/** The failed tests, at most MOST_FAILURES of them, folded away; or how many passed in all. */
function failures(run: Run, done: boolean): string[] {
  const failed = run.jobs.flatMap((job) => {
    const group = groupOf(job)
    const report = group === undefined ? undefined : run.reports.get(group)
    return (report?.failures ?? []).map((failure) => ({ group: group as string, ...failure }))
  })
  // A test group that failed with no failing test in its report failed outside any test.
  const outside = run.jobs.filter((job) => {
    const group = groupOf(job)
    return group !== undefined && job.conclusion === 'failure' && !run.reports.get(group)?.failed
  })
  if (failed.length === 0 && outside.length === 0) {
    if (!done) return []
    const passed = [...run.reports.values()].reduce((sum, report) => sum + report.passed, 0)
    return run.reports.size === 0 ? [] : [`${count(passed)} tests passed.`]
  }
  const lines = outside.map(
    (job) =>
      `${plain(job.name)} failed outside any test, before or after them: see [its log](${job.html_url ?? run.url}).`,
  )
  if (failed.length === 0) return lines
  const shown = failed.slice(0, MOST_FAILURES)
  return [
    ...lines,
    ...(lines.length ? [''] : []),
    '<details>',
    `<summary><b>${count(failed.length)} failed ${failed.length === 1 ? 'test' : 'tests'}</b></summary>`,
    '',
    ...shown.flatMap((failure) => {
      const error = failure.error.trim().split('\n').slice(0, ERROR_LINES).join('\n')
      return [
        `**${plain(failure.name)}** · \`${failure.file.replace(/`/g, '')}\` · ${plain(failure.group)}`,
        '',
        fenced(error),
        '',
      ]
    }),
    ...(failed.length > shown.length
      ? [`And ${count(failed.length - shown.length)} more, in [the run's logs](${run.url}).`, '']
      : []),
    '</details>',
  ]
}

/** The comment's text, in GitHub's Markdown. */
export function ciComment(run: Run): string {
  const done = run.conclusion !== null
  const updated = `${run.now.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const jobs = run.jobs.filter((job) => !UNLISTED.includes(job.name))
  const summary = [
    ['Status', `**${STATE[done ? (run.conclusion as string) : 'running'] ?? `❔ ${run.conclusion}`}**`],
    ['Commit', `[\`${run.sha.slice(0, 7)}\`](https://github.com/${run.repo}/commit/${run.sha})`],
    ['Updated', updated],
    ['Logs', `[Workflow run](${run.url})`],
  ]
  const [head, ...body] = summary.map(([name, value]) => `| **${name}** | ${value} |`)
  const tests = failures(run, done)
  return [
    MARKER,
    '<picture>',
    `  <source media="(prefers-color-scheme: dark)" srcset="${BRAND}/lockup-horizontal-reversed.png">`,
    `  <img alt="cubepals" src="${BRAND}/lockup-horizontal.png" height="28">`,
    '</picture>',
    '',
    '**Checks**',
    '',
    head,
    '| --- | --- |',
    ...body,
    '',
    ...(jobs.length
      ? [
          '| Part | Result | Passed | Failed | Skipped | Took |',
          '| --- | --- | ---: | ---: | ---: | ---: |',
          ...jobs.map((job) => {
            const group = groupOf(job)
            return row(job, group === undefined ? undefined : run.reports.get(group))
          }),
          '',
        ]
      : []),
    ...(tests.length ? [...tests, ''] : []),
  ].join('\n')
}

/** Each test group's report under `dir`, where each artifact was downloaded to its own directory. */
export function readReports(dir: string): Map<string, Report> {
  const reports = new Map<string, Report>()
  let artifacts: string[]
  try {
    artifacts = readdirSync(dir)
  } catch {
    return reports
  }
  for (const artifact of artifacts.filter((name) => name.startsWith(ARTIFACT))) {
    for (const file of readdirSync(join(dir, artifact)).filter((name) => name.endsWith('.xml'))) {
      reports.set(
        artifact.slice(ARTIFACT.length),
        parseJunit(readFileSync(join(dir, artifact, file), 'utf8')),
      )
    }
  }
  return reports
}

interface WorkflowRun {
  event: string
  status: string
  conclusion: string | null
  head_sha: string
  head_branch: string
  html_url: string
  head_repository: { full_name: string; owner: { login: string } } | null
  pull_requests: { number: number }[]
}

interface Pull {
  number: number
  head: { sha: string }
}

/** The open pull request the run is for: GitHub names it, but for a fork's, found by its head. */
async function pullOf(repo: string, run: WorkflowRun): Promise<Pull | undefined> {
  const named = run.pull_requests[0]?.number
  if (named !== undefined) return (await (await github(`repos/${repo}/pulls/${named}`)).json()) as Pull
  if (!run.head_repository) return undefined
  const head = encodeURIComponent(`${run.head_repository.owner.login}:${run.head_branch}`)
  const pulls = (await (await github(`repos/${repo}/pulls?state=open&head=${head}`)).json()) as Pull[]
  return pulls[0]
}

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

if (import.meta.main) {
  const repo = need('REPO')
  const id = need('RUN_ID')
  const run = (await (await github(`repos/${repo}/actions/runs/${id}`)).json()) as WorkflowRun
  const pull = run.event === 'pull_request' ? await pullOf(repo, run) : undefined
  // A push to main gets no comment, and an older commit's run doesn't write over a newer one's.
  if (!pull) process.stdout.write('No open pull request is this run’s.\n')
  else if (pull.head.sha !== run.head_sha)
    process.stdout.write('The pull request has moved on from this run.\n')
  // Results are written once the reports are downloaded; a late "running" doesn't write over them.
  else if (run.status === 'completed' && !process.env.JUNIT)
    process.stdout.write('The run is done already.\n')
  else {
    const jobs = (await (await github(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`)).json()) as {
      jobs: Job[]
    }
    const body = ciComment({
      repo,
      sha: run.head_sha,
      url: run.html_url,
      conclusion: run.status === 'completed' ? run.conclusion : null,
      jobs: jobs.jobs,
      reports: process.env.JUNIT ? readReports(process.env.JUNIT) : new Map(),
      now: new Date(),
    })
    await keepComment(repo, pull.number, MARKER, body)
  }
}

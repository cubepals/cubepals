// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ci-comment.ts's reading of bun's JUnit reports, made by bun itself from small fixture files, and
 * the comment it writes from them and a run's jobs: running, passed, failed, skipped parts, a
 * fork's run and a long list of failures; and that a job that finds the run done writes its
 * results, whatever event started it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ciComment,
  type Job,
  MARKER,
  parseJunit,
  type Report,
  type Run,
  readReports,
  report,
} from './ci-comment.ts'

// The reports come from bun itself: each fixture runs under `bun test --reporter=junit`.
const FIXTURES = {
  passing: `
    import { describe, expect, test } from 'bun:test'
    describe('servers', () => {
      test('start', () => expect(1).toBe(1))
      describe('sleep', () => { test('when idle', () => expect(2).toBe(2)) })
      test.skip('later', () => {})
    })
  `,
  failing: `
    import { expect, test } from 'bun:test'
    test('passes', () => expect(1).toBe(1))
    test('names <its> | "pipes"', () => expect({ players: 2 }).toEqual({ players: 3 }))
  `,
  many: `
    import { expect, test } from 'bun:test'
    for (let i = 1; i <= 25; i++) test('case ' + i, () => expect(i).toBe(0))
  `,
}

let dir: string
const xml: Record<string, string> = {}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-comment-'))
  for (const [name, source] of Object.entries(FIXTURES)) {
    writeFileSync(join(dir, `${name}.test.ts`), source)
    const out = join(dir, `${name}.xml`)
    Bun.spawnSync(['bun', 'test', `./${name}.test.ts`, '--reporter=junit', `--reporter-outfile=${out}`], {
      cwd: dir,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    xml[name] = readFileSync(out, 'utf8')
  }
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const at = (minutes: number, seconds: number) =>
  `2026-10-11T14:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}Z`

const job = (name: string, conclusion: string | null, overrides: Partial<Job> = {}): Job => ({
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  html_url: `https://github.com/cubepals/cubepals/actions/runs/1/job/${name.length}`,
  started_at: at(0, 0),
  completed_at: conclusion === null ? null : at(2, 41),
  ...overrides,
})

const base = {
  repo: 'cubepals/cubepals',
  sha: 'b226b58a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f',
  url: 'https://github.com/cubepals/cubepals/actions/runs/1',
  now: new Date('2026-10-11T14:02:33Z'),
}

const parts = (tests: string | null, others: string | null = 'success'): Job[] => [
  job('Find what changed', 'success'),
  job('Every file has a license', 'success'),
  job('Lint, types and structure', others),
  job('Web app builds as a Worker', others),
  job('Images build and start', others),
  job('Tests, Server lifecycle', tests),
  job('Tests, Web app, edge and scripts', tests),
  job('check', tests === null ? null : 'success'),
]

const run = (overrides: Partial<Run>): Run => ({
  ...base,
  conclusion: 'success',
  jobs: parts('success'),
  reports: new Map(),
  ...overrides,
})

describe('parseJunit', () => {
  test("counts passed and skipped, and names a test by its describe blocks' names", () => {
    expect(parseJunit(xml.passing as string)).toEqual({ passed: 2, failed: 0, skipped: 1, failures: [] })
  })

  test('a failure: its file, its name and its error, unescaped', () => {
    const report = parseJunit(xml.failing as string)
    expect(report).toMatchObject({ passed: 1, failed: 1, skipped: 0 })
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]?.file).toBe('failing.test.ts')
    expect(report.failures[0]?.name).toBe('names <its> | "pipes"')
    expect(report.failures[0]?.error).toContain('expect(received).toEqual(expected)')
    expect(report.failures[0]?.error).toContain('"players": 3')
  })
})

describe('ciComment', () => {
  test('while CI runs: running, each part as it stands, no counts', () => {
    const body = ciComment(run({ conclusion: null, jobs: parts(null) }))
    expect(body.startsWith(MARKER)).toBe(true)
    expect(body).toContain('lockup-horizontal.png')
    expect(body).toContain('| **Status** | **⏳ Running** |')
    expect(body).toContain(`[\`b226b58\`](https://github.com/cubepals/cubepals/commit/${base.sha})`)
    expect(body).toContain('| **Updated** | 2026-10-11 14:02 UTC |')
    expect(body).toContain(`[Workflow run](${base.url})`)
    expect(body).toMatch(/\| \[Tests, Server lifecycle\]\([^)]+\) \| ⏳ Running \| {2}\| {2}\| {2}\| {2}\|/)
    expect(body).not.toContain('passed.')
  })

  test('passed: every part, the test counts and times, and how many passed in all', () => {
    const passing = parseJunit(xml.passing as string)
    const reports = new Map<string, Report>([
      ['Server lifecycle', passing],
      ['Web app, edge and scripts', { ...passing, passed: 1200 }],
    ])
    const body = ciComment(run({ reports }))
    expect(body).toContain('| **Status** | **✅ Passed** |')
    expect(body).toMatch(
      /\| \[Lint, types and structure\]\([^)]+\) \| ✅ Passed \| {2}\| {2}\| {2}\| 2m 41s \|/,
    )
    expect(body).toMatch(/\| \[Tests, Server lifecycle\]\([^)]+\) \| ✅ Passed \| 2 \| 0 \| 1 \| 2m 41s \|/)
    expect(body).toContain('| 1,200 | 0 | 1 |')
    expect(body).not.toContain('Find what changed')
    expect(body).not.toContain('[check]')
    expect(body).toContain('1,202 tests passed.')
    expect(body).not.toContain('<details>')
  })

  test('failed: the failed test by name and file, with its error folded away', () => {
    const reports = new Map([['Server lifecycle', parseJunit(xml.failing as string)]])
    const jobs = parts('success').map((j) =>
      j.name === 'Tests, Server lifecycle' ? { ...j, conclusion: 'failure' } : j,
    )
    const body = ciComment(run({ conclusion: 'failure', jobs, reports }))
    expect(body).toContain('| **Status** | **❌ Failed** |')
    expect(body).toMatch(/Tests, Server lifecycle\]\([^)]+\) \| ❌ Failed \| 1 \| 1 \| 0 \|/)
    expect(body).toContain('<summary><b>1 failed test</b></summary>')
    expect(body).toContain('**names &lt;its&gt; \\| "pipes"** · `failing.test.ts` · Server lifecycle')
    expect(body).toContain('```\nAssertionError: expect(received).toEqual(expected)')
    expect(body).not.toContain('tests passed.')
  })

  test('a group that failed with no failed test says it failed outside them', () => {
    const jobs = parts('success').map((j) =>
      j.name === 'Tests, Server lifecycle' ? { ...j, conclusion: 'failure' } : j,
    )
    const body = ciComment(run({ conclusion: 'failure', jobs }))
    expect(body).toContain(
      'Tests, Server lifecycle failed outside any test, before or after them: see [its log](',
    )
    expect(body).not.toContain('<details>')
  })

  test('a change to nothing but prose: the skipped parts say why, not that they failed', () => {
    const jobs = [
      job('Find what changed', 'success'),
      job('Every file has a license', 'success'),
      job('Lint, types and structure', 'skipped', { started_at: null, completed_at: null }),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's name for a skipped matrix job, unexpanded.
      job('Tests, ${{ matrix.group }}', 'skipped', { started_at: null, completed_at: null }),
      job('check', 'success'),
    ]
    const body = ciComment(run({ jobs }))
    expect(body).toContain('| **Status** | **✅ Passed** |')
    expect(body).toMatch(
      /\| \[Lint, types and structure\]\([^)]+\) \| ⏭️ Skipped: nothing it covers changed \|/,
    )
    expect(body).toMatch(
      /\| \[Tests\]\([^)]+\) \| ⏭️ Skipped: nothing it covers changed \| {2}\| {2}\| {2}\| {2}\|/,
    )
    expect(body).not.toContain('❌')
    expect(body).not.toContain('tests passed')
  })

  test("a fork's run reads the same: nothing in it depends on where the head is", () => {
    const fork = ciComment(run({ sha: 'f00dbabe'.repeat(5) }))
    expect(fork).toContain('[`f00dbab`](https://github.com/cubepals/cubepals/commit/f00dbabe')
  })

  test('a long failure list keeps to the first twenty and says how many more', () => {
    const reports = new Map([['Server lifecycle', parseJunit(xml.many as string)]])
    const body = ciComment(run({ conclusion: 'failure', reports }))
    expect(body).toContain('<summary><b>25 failed tests</b></summary>')
    expect(body).toContain('**case 20**')
    expect(body).not.toContain('**case 21**')
    expect(body).toContain(`And 5 more, in [the run's logs](${base.url}).`)
  })
})

describe('readReports', () => {
  test('reads each group from its artifact directory, by its name', () => {
    const downloads = join(dir, 'downloads')
    mkdirSync(join(downloads, 'junit-Server lifecycle'), { recursive: true })
    mkdirSync(join(downloads, 'something-else'), { recursive: true })
    writeFileSync(join(downloads, 'junit-Server lifecycle', 'junit.xml'), xml.passing as string)
    writeFileSync(join(downloads, 'something-else', 'junit.xml'), xml.failing as string)
    const reports = readReports(downloads)
    expect([...reports.keys()]).toEqual(['Server lifecycle'])
    expect(reports.get('Server lifecycle')?.passed).toBe(2)
  })

  test('no directory: no reports', () => {
    expect(readReports(join(dir, 'nowhere')).size).toBe(0)
  })
})

describe('report', () => {
  // GitHub's API as the job sees it: the run, its pull request, its jobs and the comment so far.
  const realFetch = globalThis.fetch
  const writes: { method: string; path: string; body: string }[] = []
  let status = 'in_progress'

  beforeAll(() => {
    process.env.GH_TOKEN = 'token'
    const done = () => status === 'completed'
    const answers: Record<string, () => unknown> = {
      '/repos/cubepals/cubepals/actions/runs/1': () => ({
        event: 'pull_request',
        status,
        conclusion: done() ? 'success' : null,
        head_sha: base.sha,
        head_branch: 'feature',
        html_url: base.url,
        head_repository: { full_name: 'cubepals/cubepals', owner: { login: 'cubepals' } },
        pull_requests: [{ number: 97 }],
      }),
      '/repos/cubepals/cubepals/actions/runs/1/jobs': () => ({ jobs: parts(done() ? 'success' : null) }),
      '/repos/cubepals/cubepals/pulls/97': () => ({ number: 97, head: { sha: base.sha } }),
      '/repos/cubepals/cubepals/issues/97/comments': () => [
        { id: 5, body: `${MARKER}\nRunning`, user: { login: 'github-actions[bot]' } },
      ],
    }
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const { pathname, search } = new URL(url)
      if (init.method)
        writes.push({ method: init.method, path: pathname, body: JSON.parse(`${init.body}`).body })
      const answer = init.method ? () => ({}) : answers[pathname]
      return answer
        ? new Response(JSON.stringify(answer()), { status: 200 })
        : new Response(`${pathname}${search}`, { status: 404 })
    }) as typeof fetch
  })

  afterAll(() => {
    globalThis.fetch = realFetch
  })

  test('an in_progress event handled after the run completed writes the final results', async () => {
    const downloads = join(dir, 'late')
    mkdirSync(join(downloads, 'junit-Server lifecycle'), { recursive: true })
    writeFileSync(join(downloads, 'junit-Server lifecycle', 'junit.xml'), xml.passing as string)
    status = 'completed'
    writes.length = 0
    expect(await report('cubepals/cubepals', '1', downloads, base.now)).toBe('Wrote the results.')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.method).toBe('PATCH')
    expect(writes[0]?.path).toBe('/repos/cubepals/cubepals/issues/comments/5')
    expect(writes[0]?.body).toContain('| **Status** | **✅ Passed** |')
    expect(writes[0]?.body).toMatch(/Tests, Server lifecycle\]\([^)]+\) \| ✅ Passed \| 2 \| 0 \| 1 \|/)
    expect(writes[0]?.body).not.toContain('Running')
  })

  test("a run done whose reports couldn't be downloaded still writes its result", async () => {
    status = 'completed'
    writes.length = 0
    expect(await report('cubepals/cubepals', '1', undefined, base.now)).toBe('Wrote the results.')
    expect(writes[0]?.body).toContain('| **Status** | **✅ Passed** |')
  })

  test('while the run runs: it says so', async () => {
    status = 'in_progress'
    writes.length = 0
    expect(await report('cubepals/cubepals', '1', undefined, base.now)).toBe('Wrote that the run is going.')
    expect(writes[0]?.body).toContain('| **Status** | **⏳ Running** |')
  })
})

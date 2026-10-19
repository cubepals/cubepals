// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// The CLI against a fake GitHub: what it reads, what it writes, and what it leaves alone.
import { afterAll, beforeEach, expect, test } from 'bun:test'

type Call = { method: string; path: string; body: unknown }
let calls: Call[] = []
let state: {
  labels: string[]
  events: { event: string; actor: { login: string }; label: { name: string } }[]
  files: { filename: string; additions: number; deletions: number; status: string }[]
  title: string
  issue: boolean
  checkRun: string | null
  closed?: boolean
  repoLabels: { name: string; color: string; description: string }[]
}

beforeEach(() => {
  calls = []
  state = {
    labels: [],
    events: [],
    files: [{ filename: '.github/workflows/pr-assignee.yml', additions: 29, deletions: 0, status: 'added' }],
    title: 'Assign each pull request to its author',
    issue: false,
    checkRun: null,
    repoLabels: [],
  }
})

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    const body = request.method === 'GET' ? null : await request.json().catch(() => null)
    calls.push({ method: request.method, path, body })
    const json = (data: unknown) => Response.json(data)
    const page = Number(url.searchParams.get('page') ?? 1)
    if (path === '/repos/o/r/pulls/7')
      return json({
        number: 7,
        title: state.title,
        body: '',
        user: { login: 'someone' },
        labels: state.labels.map((name) => ({ name })),
        state: state.closed ? 'closed' : 'open',
        head: { sha: 'abc' },
        merged_at: null,
      })
    if (path === '/repos/o/r/pulls/7/files') return json(page === 1 ? state.files : [])
    if (path === '/repos/o/r/issues/8')
      return json({
        number: 8,
        title: 'The map is blank',
        body: '',
        user: { login: 'someone' },
        labels: state.labels.map((name) => ({ name })),
      })
    if (path.endsWith('/events')) return json(page === 1 ? state.events : [])
    if (path.endsWith('/labels') && request.method === 'GET' && path.includes('/issues/'))
      return json(state.labels.map((name) => ({ name })))
    if (path.endsWith('/labels') && request.method === 'POST' && path.includes('/issues/')) return json([])
    if (path.includes('/labels/') && request.method === 'DELETE') return new Response(null, { status: 204 })
    if (path.includes('/actions/workflows/labels-check.yml/runs'))
      return json({ workflow_runs: state.checkRun ? [{ id: 99, conclusion: state.checkRun }] : [] })
    if (path.endsWith('/rerun-failed-jobs')) return new Response(null, { status: 201 })
    if (path === '/repos/o/r/labels' && request.method === 'GET')
      return json(page === 1 ? state.repoLabels : [])
    if (path.startsWith('/repos/o/r/labels')) return json({})
    if (path === '/repos/o/r/issues') return json([])
    return new Response('not faked', { status: 404 })
  },
})
afterAll(() => server.stop())

async function run(...args: string[]) {
  const env = {
    ...process.env,
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GH_TOKEN: 't',
    LABELS_WAIT: '0',
    ANTHROPIC_API_KEY: '',
  }
  const child = Bun.spawn(['bun', `${import.meta.dir}/cli.ts`, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { out, err, code }
}
const added = () =>
  calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/labels'))
    .flatMap((c) => (c.body as { labels: string[] }).labels)
const removed = () =>
  calls.filter((c) => c.method === 'DELETE').map((c) => decodeURIComponent(c.path.split('/').pop() ?? ''))

test('a pull request gets its kind, area, size and impact', async () => {
  expect((await run('pr', '7')).code).toBe(0)
  expect(added().sort()).toEqual(['area/ci', 'impact/internal', 'kind/chore', 'size/S'])
})

test('a push that changes the size swaps it', async () => {
  state.labels = ['kind/chore', 'area/ci', 'size/L', 'impact/internal']
  await run('pr', '7')
  expect(added()).toEqual(['size/S'])
  expect(removed()).toEqual(['size/L'])
})

test('what a person chose or removed stays', async () => {
  state.labels = ['kind/feature']
  state.events = [
    { event: 'unlabeled', actor: { login: 'a-maintainer' }, label: { name: 'impact/internal' } },
  ]
  await run('pr', '7')
  expect(added().sort()).toEqual(['area/ci', 'size/S'])
})

test('the bot taking a label off is not a person', async () => {
  state.events = [{ event: 'unlabeled', actor: { login: 'github-actions[bot]' }, label: { name: 'size/S' } }]
  await run('pr', '7')
  expect(added()).toContain('size/S')
})

test('a failed check is re-run once labels are on', async () => {
  state.checkRun = 'failure'
  await run('pr', '7')
  expect(calls.some((c) => c.path.endsWith('/actions/runs/99/rerun-failed-jobs'))).toBe(true)
})

test('a merged pull request is labelled without looking for a check to re-run', async () => {
  state.closed = true
  state.checkRun = 'failure'
  await run('pr', '7')
  expect(added().length).toBeGreaterThan(0)
  expect(calls.some((c) => c.path.includes('/actions/'))).toBe(false)
})

test('nothing to add reads no timeline', async () => {
  state.labels = ['kind/chore', 'area/ci', 'size/S', 'impact/internal']
  await run('pr', '7')
  expect(calls.some((c) => c.path.endsWith('/events'))).toBe(false)
})

test('--dry-run writes nothing', async () => {
  state.checkRun = 'failure'
  await run('pr', '7', '--dry-run')
  expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
})

test('the check passes with one kind, an area and one size, and says what is missing otherwise', async () => {
  state.labels = ['kind/bug', 'area/web', 'size/M']
  expect((await run('check', '7')).code).toBe(0)
  state.labels = ['area/web']
  const failed = await run('check', '7')
  expect(failed.code).toBe(1)
  expect(failed.err).toContain('a kind/ label, one size/ label')
})

test('an issue without a model waits in needs-triage', async () => {
  state.labels = ['kind/bug']
  await run('issue', '8')
  expect(added()).toEqual(['needs-triage'])
})

test('an issue with a kind and an area leaves triage', async () => {
  state.labels = ['kind/bug', 'area/web', 'needs-triage']
  await run('issue', '8')
  expect(removed()).toEqual(['needs-triage'])
})

test('sync renames GitHub defaults in place and makes the rest', async () => {
  state.repoLabels = [{ name: 'bug', color: 'd73a4a', description: "Something isn't working" }]
  await run('sync')
  const rename = calls.find((c) => c.method === 'PATCH' && c.path === '/repos/o/r/labels/bug')
  expect(rename?.body).toEqual({ new_name: 'kind/bug' })
  expect(calls.filter((c) => c.method === 'POST' && c.path === '/repos/o/r/labels').length).toBeGreaterThan(
    30,
  )
})

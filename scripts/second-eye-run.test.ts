// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Exercises the review workflow's GitHub writes, including skips, stale heads and API failures. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LABELS, MARKER, runSecondEyeComment } from './second-eye-comment.ts'
import { runSecondEyeGate } from './second-eye-gate.ts'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const HEAD = 'fedcba9876543210fedcba9876543210fedcba98'
const REPO = 'cubepals/cubepals'
const original = { ...process.env }
const originalFetch = globalThis.fetch
let dir: string
let head = SHA
let labels: string[] = []
let comments: { id: number; body: string; user: { login: string } }[] = []
let statuses: { context: string; state: string }[] = []
let files: { filename: string; previous_filename?: string }[] = []
let calls: { path: string; method: string; body: unknown }[] = []
let fetcher: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'second-eye-run-'))
  head = SHA
  labels = []
  comments = []
  statuses = []
  files = []
  calls = []
  Object.assign(process.env, {
    GH_TOKEN: 'test-token',
    REPO,
    PULL: '42',
    EVENT: 'pull_request',
    ACTION: 'synchronize',
    ACTOR: 'v0id-user',
    TRIGGERING_ACTOR: 'v0id-user',
    AUTHOR: 'v0id-user',
    SAME_REPO: 'true',
    GITHUB_RUN_ID: '7',
    GITHUB_OUTPUT: join(dir, 'output'),
    SHA,
    MODE: 'status',
    SENSITIVE: 'true',
    MARK: 'success',
    REVIEW: 'success',
    COMMENT: 'success',
  })
  for (const key of ['DECIDE', 'NOTICE', 'UNAVAILABLE', 'DRAFT', 'FORCE', 'COMMENT_AUTHOR'])
    delete process.env[key]
  fetcher = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const path = String(url).replace('https://api.github.com/', '')
        const method = init?.method ?? 'GET'
        calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        if (method !== 'GET') return Response.json({})
        if (path.endsWith('/pulls/42'))
          return Response.json({ head: { sha: head }, labels: labels.map((name) => ({ name })) })
        if (path.includes('/comments?')) return Response.json(comments)
        if (path.includes('/files?')) return Response.json(files)
        if (path.endsWith('/status')) return Response.json({ statuses })
        throw new Error(`Unexpected GitHub request: ${path}`)
      },
      { preconnect: originalFetch.preconnect },
    ),
  )
})

afterEach(() => {
  fetcher.mockRestore()
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  rmSync(dir, { recursive: true, force: true })
})

test('a 429 notice is created without an approval or invented review findings', async () => {
  process.env.NOTICE = 'unavailable'
  process.env.REVIEWED = JSON.stringify({ sha: SHA })
  labels = Object.values(LABELS)
  await runSecondEyeComment()
  const comment = calls.find((call) => call.method === 'POST' && call.path.endsWith('/comments'))
  expect(comment?.body).toEqual({
    body: `${MARKER}\n> ⏸️ **Automated review unavailable.** Skipped for [\`0123456\`](https://github.com/${REPO}/commit/${SHA}).\n`,
  })
  expect(JSON.stringify(comment?.body)).not.toContain('second-eye-data')
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
  expect(calls.find((call) => call.path.endsWith('/labels') && call.method === 'POST')?.body).toEqual({
    labels: ['needs-second-eye'],
  })
})

test('an unavailable review preserves earlier findings and never labels a newer commit unavailable', async () => {
  process.env.NOTICE = 'unavailable'
  process.env.REVIEWED = JSON.stringify({ sha: SHA })
  comments = [{ id: 9, body: `${MARKER}\nEarlier findings`, user: { login: 'github-actions[bot]' } }]
  labels = ['needs-second-eye']
  await runSecondEyeComment()
  expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
    body: expect.stringContaining('Earlier findings'),
  })
  head = HEAD
  calls = []
  await runSecondEyeComment()
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
})

test('unavailability sets an explicit skipped status, while failed notices cannot pass', async () => {
  process.env.UNAVAILABLE = 'true'
  await runSecondEyeGate()
  expect(calls.at(-1)).toEqual({
    path: `repos/${REPO}/statuses/${SHA}`,
    method: 'POST',
    body: {
      state: 'success',
      context: 'Second eye gate',
      description: 'Automated review unavailable. Skipped for this commit.',
      target_url: `https://github.com/${REPO}/actions/runs/7`,
    },
  })
  process.env.COMMENT = 'failure'
  calls = []
  await runSecondEyeGate()
  expect(calls.at(-1)?.body).toMatchObject({ state: 'failure' })
  statuses = [{ context: 'Second eye gate', state: 'success' }]
  calls = []
  await runSecondEyeGate()
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
  statuses = [{ context: 'Another check', state: 'success' }]
  calls = []
  await runSecondEyeGate()
  expect(calls.at(-1)?.body).toMatchObject({ state: 'failure' })
  statuses = [{ context: 'Second eye gate', state: 'failure' }]
  calls = []
  await runSecondEyeGate()
  expect(calls.at(-1)?.body).toMatchObject({ state: 'failure' })
})

test('path analysis includes renamed sensitive files and fails closed at the API listing limit', async () => {
  process.env.MODE = 'paths'
  files = [{ filename: 'readme.md', previous_filename: 'apps/edge/front.ts' }]
  await runSecondEyeGate()
  expect(readFileSync(process.env.GITHUB_OUTPUT as string, 'utf8')).toContain('sensitive=true\nauto=true')
  files = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` }))
  calls = []
  await runSecondEyeGate()
  expect(calls).toHaveLength(30)
  files = []
  process.env.GITHUB_OUTPUT = join(dir, 'non-sensitive')
  await runSecondEyeGate()
  expect(readFileSync(process.env.GITHUB_OUTPUT, 'utf8')).toBe('sensitive=false\nauto=false\n')
})

test('invalid status targets and unrelated manual runs write no status', async () => {
  process.env.SHA = 'bad'
  await runSecondEyeGate()
  expect(calls).toHaveLength(0)
  for (const invalid of [`prefix${SHA}`, `${SHA}suffix`]) {
    process.env.SHA = invalid
    await runSecondEyeGate()
    expect(calls).toHaveLength(0)
  }
  process.env.SHA = SHA
  process.env.EVENT = 'workflow_dispatch'
  process.env.REVIEW = 'failure'
  await runSecondEyeGate()
  expect(calls).toHaveLength(0)
  process.env.MODE = 'unknown'
  await expect(runSecondEyeGate()).rejects.toThrow('MODE')
})

test('a GitHub failure cannot become a published availability notice', async () => {
  process.env.NOTICE = 'unavailable'
  process.env.REVIEWED = JSON.stringify({ sha: SHA })
  fetcher.mockResolvedValue(new Response(null, { status: 503 }))
  await expect(runSecondEyeComment()).rejects.toThrow('GitHub answered')
})

test('a completed review publishes its actual verdict, and a later head keeps it stale', async () => {
  process.env.REVIEW = JSON.stringify({ verdict: 'merge', findings: [], files_reviewed: 1 })
  process.env.REVIEWED = JSON.stringify({ sha: SHA, files: 1, additions: 12, deletions: 3 })
  process.env.MODEL = 'test-model'
  process.env.PREVIOUS = JSON.stringify({ sha: HEAD, findings: [] })
  labels = [LABELS['fix first']]
  await runSecondEyeComment()
  expect(calls.find((call) => call.path.endsWith('/labels') && call.method === 'POST')?.body).toEqual({
    labels: [LABELS.merge],
  })
  expect(calls.find((call) => call.path.endsWith('/comments') && call.method === 'POST')?.body).toEqual({
    body: expect.stringContaining('Verdict: Merge'),
  })
  const published = calls.find((call) => call.path.endsWith('/comments') && call.method === 'POST')?.body as {
    body: string
  }
  expect(published.body).toContain('1 file, +12 −3 lines')
  expect(published.body).toContain('test-model')
  expect(published.body).toContain(`https://github.com/${REPO}/actions/runs/7`)
  expect(published.body).toContain('Bugs, security')
  expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
    `repos/${REPO}/issues/42/labels/review%2Fai-fix-first`,
  ])
  head = HEAD
  calls = []
  delete process.env.PREVIOUS
  delete process.env.MODEL
  await runSecondEyeComment()
  expect(calls.find((call) => call.path.endsWith('/comments') && call.method === 'POST')?.body).toEqual({
    body: expect.stringContaining('Reviewed an older commit'),
  })
  expect(calls.some((call) => JSON.stringify(call.body) === JSON.stringify({ labels: [LABELS.merge] }))).toBe(
    false,
  )
})

test('review publication defaults missing metadata and keeps an existing correct verdict label', async () => {
  process.env.REVIEW = JSON.stringify({ verdict: 'merge', findings: [] })
  process.env.REVIEWED = JSON.stringify({ sha: SHA })
  delete process.env.MODEL
  labels = [LABELS.merge]
  await runSecondEyeComment()
  const published = calls.find((call) => call.path.endsWith('/comments') && call.method === 'POST')?.body as {
    body: string
  }
  expect(published.body).toContain('0 files, +0 −0 lines')
  expect(published.body).not.toContain('Stryker was here')
  expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
})

test('starting decisions write no comments, and stale notices keep the old review', async () => {
  process.env.DECIDE = '1'
  comments = [
    {
      id: 9,
      body: `${MARKER}\n[old](https://github.com/${REPO}/commit/${SHA})`,
      user: { login: 'github-actions[bot]' },
    },
  ]
  process.env.EVENT = 'workflow_dispatch'
  await runSecondEyeComment()
  expect(readFileSync(process.env.GITHUB_OUTPUT as string, 'utf8')).toContain('review=false\nnotice=none')
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
  delete process.env.DECIDE
  process.env.NOTICE = 'failed'
  await runSecondEyeComment()
  expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
    body: expect.stringContaining("didn't finish"),
  })
  comments = []
  calls = []
  process.env.NOTICE = 'draft'
  await runSecondEyeComment()
  expect(calls.some((call) => call.path.endsWith('/comments') && call.method === 'POST')).toBe(false)
})

test('missing configuration and unsupported notices fail instead of publishing', async () => {
  process.env.NOTICE = 'unsupported'
  await expect(runSecondEyeComment()).rejects.toThrow('NOTICE')
  delete process.env.NOTICE
  delete process.env.REVIEW
  await expect(runSecondEyeComment()).rejects.toThrow('REVIEW')
  delete process.env.REPO
  await expect(runSecondEyeGate()).rejects.toThrow('REPO')
})

test('draft and forced review starts record their actual decision', async () => {
  process.env.DECIDE = '1'
  process.env.DRAFT = 'true'
  await runSecondEyeComment()
  expect(readFileSync(process.env.GITHUB_OUTPUT as string, 'utf8')).toBe('review=false\nnotice=draft\n')
  process.env.DRAFT = 'false'
  process.env.EVENT = 'workflow_dispatch'
  process.env.FORCE = 'true'
  process.env.GITHUB_OUTPUT = join(dir, 'forced-output')
  comments = [
    {
      id: 9,
      body: `${MARKER}\n[old](https://github.com/${REPO}/commit/${SHA})`,
      user: { login: 'github-actions[bot]' },
    },
  ]
  await runSecondEyeComment()
  expect(readFileSync(process.env.GITHUB_OUTPUT, 'utf8')).toBe('review=true\nnotice=running\n')
})

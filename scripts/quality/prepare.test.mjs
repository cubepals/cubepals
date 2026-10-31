// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Real Git histories prove a moving PR base cannot expand or hide the measured change. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const prepare = fileURLToPath(new URL('./prepare.mjs', import.meta.url))

function history(t) {
  const root = mkdtempSync(join(tmpdir(), 'quality-comparison-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Quality fixture')
  git('config', 'user.email', 'quality@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  const commit = (file, contents) => {
    writeFileSync(join(root, file), contents)
    git('add', file)
    git('commit', '-q', '--no-gpg-sign', '-m', 'Fixture change')
    return git('rev-parse', 'HEAD')
  }
  const original = commit('existing.ts', 'export const existing = true\n')
  git('switch', '-q', '-c', 'proposal')
  const proposed = commit('proposal.ts', 'export const proposal = true\n')
  git('switch', '-q', 'main')
  const advanced = commit('upstream.ts', 'export const upstream = true\n')
  git('merge', '-q', '--no-ff', '--no-edit', '--no-gpg-sign', 'proposal')
  return { root, git, original, proposed, advanced, merge: git('rev-parse', 'HEAD') }
}

function run(fixture, base, prHead = '') {
  return spawnSync(process.execPath, [prepare, join(fixture.root, 'evidence')], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, QUALITY_BASE_REF: base, QUALITY_PR_HEAD: prHead, GITHUB_OUTPUT: '' },
  })
}

function evidence(fixture, file) {
  return JSON.parse(readFileSync(join(fixture.root, 'evidence', file), 'utf8'))
}

test('an upstream merge after the PR event is baseline code, not proposed mutation scope', (t) => {
  const fixture = history(t)
  const result = run(fixture, fixture.original, fixture.proposed)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(evidence(fixture, 'comparison.json'), { base: fixture.advanced, head: fixture.merge })
  assert.deepEqual(evidence(fixture, 'changed.json'), ['proposal.ts'])
})

test('a matching PR event base also records only the proposed change', (t) => {
  const fixture = history(t)
  const result = run(fixture, fixture.advanced, fixture.proposed)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(evidence(fixture, 'changed.json'), ['proposal.ts'])
})

test('a checkout of the PR branch itself cannot masquerade as the synthetic merge', (t) => {
  const fixture = history(t)
  fixture.git('checkout', '-q', fixture.proposed)
  const result = run(fixture, fixture.original, fixture.proposed)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /two-parent merge of the expected PR head/)
  assert.equal(existsSync(join(fixture.root, 'evidence', 'comparison.json')), false)
})

test('a merge of a different PR revision cannot produce comparison evidence', (t) => {
  const fixture = history(t)
  const result = run(fixture, fixture.original, fixture.original)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /two-parent merge of the expected PR head/)
  assert.equal(existsSync(join(fixture.root, 'evidence', 'changed.json')), false)
})

test('a merge base unrelated to the event base is rejected', (t) => {
  const fixture = history(t)
  const result = run(fixture, fixture.proposed, fixture.proposed)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not descended from the event base/)
})

test('PR head input cannot be a branch name or Git revision expression', (t) => {
  const fixture = history(t)
  const result = run(fixture, fixture.original, 'proposal')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /expected PR head must be a commit SHA/)
})

test('merge queues retain their supplied base and include every queued change', (t) => {
  const fixture = history(t)
  const result = run(fixture, fixture.original)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(evidence(fixture, 'comparison.json'), { base: fixture.original, head: fixture.merge })
  assert.deepEqual(evidence(fixture, 'changed.json'), ['proposal.ts', 'upstream.ts'])
})

test('pushes and scheduled runs retain the previous-commit fallback', (t) => {
  const fixture = history(t)
  fixture.git('checkout', '-q', fixture.proposed)
  const result = run(fixture, '')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(evidence(fixture, 'comparison.json'), { base: fixture.original, head: fixture.proposed })
  assert.deepEqual(evidence(fixture, 'changed.json'), ['proposal.ts'])
})

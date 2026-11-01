// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Git hunks select exact lines, while new files, renames and pure deletions keep full census. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { mutationLineRanges, mutationPatterns, nonExecutableDeletion } from './mutation-lines.mjs'

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-lines-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q', '--template=', '-b', 'fixture')
  git('config', 'user.name', 'Quality fixture')
  git('config', 'user.email', 'quality@example.invalid')
  const write = (name, source) => {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), source)
  }
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'Fixture change')
    return git('rev-parse', 'HEAD')
  }
  const subject = 'apps/[room]/value.ts'
  write(
    subject,
    'export const legacy = () => 13\nexport const changed = () => 1\nexport const end = () => 7\n',
  )
  const baseSha = commit()
  const select = (subjects = [subject], headSha = git('rev-parse', 'HEAD')) =>
    mutationLineRanges({ root, baseSha, headSha, subjects })
  return { root, git, write, commit, select, subject, baseSha }
}

test('a replacement selects only its new line, including literal route brackets', (t) => {
  const r = repository(t)
  r.write(
    r.subject,
    'export const legacy = () => 13\nexport const changed = () => 2\nexport const end = () => 7\n',
  )
  r.commit()
  assert.deepEqual(r.select(), { [r.subject]: [{ start: 2, end: 2 }] })
  assert.deepEqual(mutationPatterns(r.subject, r.select()[r.subject]), ['apps/[[]room[]]/value.ts:2-2'])
})

test('multiple separated hunks retain every added line', (t) => {
  const r = repository(t)
  r.write(
    r.subject,
    'export const legacy = () => 14\nexport const changed = () => 1\nexport const end = () => 8\n',
  )
  r.commit()
  assert.deepEqual(r.select()[r.subject], [
    { start: 1, end: 1 },
    { start: 3, end: 3 },
  ])
})

test('new and renamed files have complete mutation scope', (t) => {
  const r = repository(t)
  r.git('mv', r.subject, 'apps/new.ts')
  r.commit()
  assert.deepEqual(r.select(['apps/new.ts']), { 'apps/new.ts': null })
})

test('a pure deletion retains the full affected file rather than inventing a changed line', (t) => {
  const r = repository(t)
  r.write(r.subject, 'export const legacy = () => 13\nexport const end = () => 7\n')
  r.commit()
  assert.equal(r.select()[r.subject], null)
})

test('stale head and unstaged source cannot choose their own mutation ranges', (t) => {
  const r = repository(t)
  r.write(r.subject, 'export const changed = () => 99\n')
  assert.throws(() => r.select(), /source differs from Git/)
  const head = r.commit()
  assert.notEqual(head, r.baseSha)
  assert.throws(() => r.select([r.subject], r.baseSha), /checkout differs/)
  assert.throws(() => r.select([r.subject], 'HEAD'), /authoritative commit/)
})

test('deleted imports, comments and types do not turn a changed-line release into a legacy audit', () => {
  const source =
    "import { value } from './module'\nexport interface Shape {\n value: number\n}\n// A comment\nconst runtime = 1 // a comment on executable code\n"
  for (const line of [1, 2, 3, 4, 5]) assert.equal(nonExecutableDeletion(source, 'source.ts', line, 1), true)
  assert.equal(nonExecutableDeletion(source, 'source.ts', 6, 1), false)
  assert.equal(nonExecutableDeletion('/* comment */ const runtime = 1', 'source.ts', 1, 1), false)
  assert.equal(nonExecutableDeletion('/* comment */\n', 'source.ts', 1, 1), true)
})

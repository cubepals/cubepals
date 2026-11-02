// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Verify the push hook against actual Git commits and an ephemeral SSH signing identity. */
import { afterEach, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'commit-signatures-'))
  directories.push(dir)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Signing fixture')
  git('config', 'user.email', 'signing-fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('commit', '--allow-empty', '-m', 'Historical unsigned base')
  const base = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', base)
  const hook = (mode: string, input = '') =>
    spawnSync(process.execPath, [join(import.meta.dir, 'check-signatures.ts'), mode], {
      cwd: dir,
      input,
      encoding: 'utf8',
    })
  const push = () =>
    hook('--pre-push', `refs/heads/main ${git('rev-parse', 'HEAD')} refs/heads/main ${base}\n`)
  return { dir, git, hook, push }
}

test('unsigned commits are rejected before any remote lookup', () => {
  const { git, push } = fixture()
  git('commit', '--allow-empty', '-m', 'Unsigned change')
  const result = push()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('has no valid signature')
})

test('a cryptographically verified SSH signature passes without auditing old main', () => {
  const { dir, git, push } = fixture()
  const key = join(dir, 'fixture-key')
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' })
  const signers = join(dir, 'allowed-signers')
  writeFileSync(signers, `signing-fixture@example.invalid ${readFileSync(`${key}.pub`, 'utf8')}`)
  git('config', 'gpg.format', 'ssh')
  git('config', 'user.signingkey', key)
  git('config', 'gpg.ssh.allowedSignersFile', signers)
  git('config', 'commit.gpgsign', 'true')
  git('commit', '--allow-empty', '-m', 'Signed change')
  expect(push().status).toBe(0)
})

test('disabled signing fails the commit hook', () => {
  const { hook } = fixture()
  const result = hook('--config')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Signing must be enabled')
})

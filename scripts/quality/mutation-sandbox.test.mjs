// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A real module loader must see each sandbox's mutation through root and nested workspace imports. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { mutationSnapshot } from './mutation.mjs'
import { installSandboxModules } from './mutation-sandbox.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-links-'))
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  write('.gitignore', 'node_modules/\n')
  write('package.json', JSON.stringify({ type: 'module' }))
  write(
    'packages/probe/package.json',
    JSON.stringify({ name: 'workspace-probe', type: 'module', exports: './value.js' }),
  )
  write('packages/probe/value.js', 'export const value = "original"\n')
  write('apps/probe/package.json', JSON.stringify({ type: 'module' }))
  mkdirSync(join(root, 'node_modules'))
  symlinkSync('../packages/probe', join(root, 'node_modules/workspace-probe'))
  mkdirSync(join(root, 'apps/probe/node_modules'))
  symlinkSync('../../../packages/probe', join(root, 'apps/probe/node_modules/workspace-probe'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  const snapshot = mutationSnapshot(root)
  t.after(() => {
    rmSync(snapshot, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const sandbox = (name) => {
    const path = join(snapshot, '.stryker-tmp', name)
    mkdirSync(join(path, 'packages/probe'), { recursive: true })
    mkdirSync(join(path, 'apps/probe'), { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(
      join(path, 'packages/probe/package.json'),
      JSON.stringify({ name: 'workspace-probe', type: 'module', exports: './value.js' }),
    )
    writeFileSync(join(path, 'packages/probe/value.js'), `export const value = ${JSON.stringify(name)}\n`)
    return path
  }
  return { root, snapshot, sandbox }
}

function importedValue(cwd) {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', 'import {value} from "workspace-probe"; process.stdout.write(value)'],
    { cwd, encoding: 'utf8' },
  )
}

test('bare imports reach the current sandbox from both installation locations', (t) => {
  const { snapshot, sandbox } = fixture(t)
  const current = sandbox('first')
  installSandboxModules(snapshot, current)
  assert.equal(realpathSync(join(current, 'node_modules/workspace-probe')), join(current, 'packages/probe'))
  assert.equal(importedValue(current), 'first')
  assert.equal(importedValue(join(current, 'apps/probe')), 'first')
})

test('separate sandboxes cannot import each other or the original source', (t) => {
  const { snapshot, sandbox } = fixture(t)
  const first = sandbox('first')
  const second = sandbox('second')
  installSandboxModules(snapshot, first)
  installSandboxModules(snapshot, second)
  assert.equal(importedValue(first), 'first')
  assert.equal(importedValue(second), 'second')
  assert.equal(importedValue(snapshot), 'original')
})

test('refuses a destination outside the disposable sandbox tree', (t) => {
  const { root, snapshot } = fixture(t)
  assert.throws(() => installSandboxModules(snapshot, root), /inside the disposable snapshot/)
})

test('refuses preexisting dependencies that might point to unmutated source', (t) => {
  const { snapshot, sandbox } = fixture(t)
  const current = sandbox('first')
  symlinkSync(join(snapshot, 'node_modules'), join(current, 'node_modules'))
  assert.throws(() => installSandboxModules(snapshot, current), /must not be shared/)
})

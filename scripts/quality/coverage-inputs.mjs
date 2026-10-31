// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Freezes tracked fixtures/configuration as well as source and tests while evidence is collected.
 * An unchanged test is identified by its bytes, never its name alone. It runs in a completed
 * process before any modified or new tests can affect shared filesystem or service state.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'

function trackedPaths(root) {
  return [
    ...new Set(
      execFileSync('git', ['ls-files', '-z', '--cached'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
        .split('\0')
        .filter(Boolean),
    ),
  ].sort()
}

function input(root, path) {
  const absolute = resolve(root, path)
  const stat = lstatSync(absolute)
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported tracked input: ${path}`)
  const bytes = stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute)
  return { path, mode: stat.mode, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export function snapshotInputs(root, extraPaths = []) {
  const tracked = trackedPaths(root)
  const paths = [...new Set([...tracked, ...extraPaths])].sort()
  return { tracked, extraPaths: [...extraPaths], files: paths.map((path) => input(root, path)) }
}

export function assertInputsUnchanged(root, before) {
  const after = snapshotInputs(root, before.extraPaths)
  if (JSON.stringify(before.tracked) !== JSON.stringify(after.tracked))
    throw new Error('Tracked input set changed during the test run')
  const afterFiles = new Map(after.files.map((file) => [file.path, file]))
  for (const file of before.files)
    if (JSON.stringify(file) !== JSON.stringify(afterFiles.get(file.path)))
      throw new Error(`Test run modified an input: ${file.path}`)
}

export function testManifest(tests) {
  return { version: 1, tests: tests.map(({ path, sha256 }) => ({ path, sha256 })) }
}

function checkedTests(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.tests)) throw new Error('Invalid base test manifest')
  const result = new Map()
  for (const test of manifest.tests) {
    if (
      !test ||
      typeof test.path !== 'string' ||
      !test.path ||
      test.path.startsWith('/') ||
      test.path.includes('\\') ||
      test.path.split('/').some((part) => part === '..' || part === '.' || part === '') ||
      !/^[a-f0-9]{64}$/.test(test.sha256) ||
      result.has(test.path)
    )
      throw new Error('Invalid or duplicate base test identity')
    result.set(test.path, test.sha256)
  }
  return result
}

export function partitionTests(tests, baseManifest) {
  const current = checkedTests(testManifest(tests))
  if (!baseManifest) return [{ name: 'all', tests: [...current.keys()].sort() }]
  const base = checkedTests(baseManifest)
  const unchanged = []
  const changed = []
  for (const [path, hash] of current) (base.get(path) === hash ? unchanged : changed).push(path)
  return [
    { name: 'unchanged', tests: unchanged.sort() },
    { name: 'changed', tests: changed.sort() },
  ].filter((phase) => phase.tests.length > 0)
}

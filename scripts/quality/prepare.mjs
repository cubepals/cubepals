// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Records the actual comparison commit and complete file diff, including test-only changes. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const output = resolve(process.argv[2] ?? 'coverage/quality')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const candidate = process.env.QUALITY_BASE_REF || 'HEAD^'
let base = git('rev-parse', '--verify', `${candidate}^{commit}`)
if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Cannot resolve the measured base commit')
const head = git('rev-parse', '--verify', 'HEAD^{commit}')
const prHead = process.env.QUALITY_PR_HEAD
if (prHead) {
  if (!/^[a-f0-9]{40}$/.test(prHead)) throw new Error('The expected PR head must be a commit SHA')
  const parents = git('rev-list', '--parents', '-n', '1', head).split(' ').slice(1)
  if (parents.length !== 2 || parents[1] !== prHead) {
    throw new Error('The checked-out PR must be a two-parent merge of the expected PR head')
  }
  // GitHub can regenerate the merge after the event records its base. Compare the tested merge
  // with its actual first parent so another merged PR does not become this PR's mutation scope.
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, parents[0]], { cwd: root, stdio: 'ignore' })
  } catch {
    throw new Error('The checked-out PR base is not descended from the event base')
  }
  base = parents[0]
}
const changed = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'changed.json'), `${JSON.stringify(changed, null, 2)}\n`)
writeFileSync(resolve(output, 'comparison.json'), `${JSON.stringify({ base, head }, null, 2)}\n`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base=${base}\n`)
console.warn(`Quality comparison: ${base}; ${changed.length} changed files`)

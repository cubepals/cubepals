// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Records the actual comparison commit and complete file diff, including test-only changes. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const output = resolve(process.argv[2] ?? 'coverage/quality')
mkdirSync(output, { recursive: true })
const candidate = process.env.QUALITY_BASE_REF || 'HEAD^'
const base = execFileSync('git', ['rev-parse', '--verify', `${candidate}^{commit}`], {
  cwd: root,
  encoding: 'utf8',
}).trim()
if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Cannot resolve the measured base commit')
const changed = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
writeFileSync(resolve(output, 'changed.json'), `${JSON.stringify(changed, null, 2)}\n`)
writeFileSync(
  resolve(output, 'comparison.json'),
  `${JSON.stringify({ base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }, null, 2)}\n`,
)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base=${base}\n`)
console.warn(`Quality comparison: ${base}; ${changed.length} changed files`)

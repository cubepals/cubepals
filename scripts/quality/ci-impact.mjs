// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Git-bound test selection shared by scheduling, runners and independent evidence validation. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyChanges } from './check-plan.mjs'
import { affectedSelection } from './ci-selection.mjs'
import { inventory } from './inventory.mjs'
import { dependencyGraph } from './mutation-dependencies.mjs'

const git = (root, ...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
const test = (path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('scripts/quality/')

export function ciImpact(root, base, head, mode = 'full') {
  if (!['full', 'affected'].includes(mode) || ![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error('CI impact requires exact commits and a supported execution mode')
  if (git(root, 'rev-parse', 'HEAD') !== head || git(root, 'diff', '--name-only', 'HEAD'))
    throw new Error('CI impact checkout differs from the tested commit')
  if (git(root, 'ls-files', '--others', '--exclude-standard'))
    throw new Error('CI impact requires a committed input inventory')
  git(root, 'merge-base', '--is-ancestor', base, head)
  const changed = git(root, 'diff', '--name-only', '--no-renames', base, head).split('\n').filter(Boolean)
  const checks = classifyChanges(changed, { full: process.env.QUALITY_FULL_AUDIT === 'true' })
  const lists = [base, head].map((sha) =>
    git(root, 'ls-tree', '-r', '--name-only', sha).split('\n').filter(test),
  )
  const complete = mode === 'full' || checks.broad
  if (complete)
    return {
      checks,
      changed,
      tests: lists,
      measured: null,
      services: true,
      complete,
      reasons: checks.reasons,
    }
  const temporary = mkdtempSync(join(tmpdir(), 'ci-impact-'))
  const previous = join(temporary, 'base')
  try {
    git(root, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', previous, base)
    const views = [previous, root].map((checkout, side) => {
      const entries = inventory(checkout)
      const paths = entries
        .filter((entry) => entry.kind === 'test' || entry.kind === 'source')
        .map((entry) => entry.path)
      return { ...dependencyGraph(checkout, paths, { includeData: true }), tests: lists[side] }
    })
    const selected = affectedSelection(views, changed, { website: checks.website })
    const services =
      !checks.website ||
      selected.measured.some((paths) =>
        paths.some(
          (path) =>
            /^apps\/(?:control|edge)\//.test(path) &&
            !/^apps\/control\/src\/testing\/(?:answered|refusing)/.test(path),
        ),
      )
    if (checks.code && !selected.tests[1].length)
      throw new Error('Executable changes have no head test evidence')
    return {
      ...selected,
      checks,
      changed,
      services,
      complete,
      reasons: [...checks.reasons, ...selected.reasons],
    }
  } finally {
    try {
      git(root, 'worktree', 'remove', '--force', previous)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
}

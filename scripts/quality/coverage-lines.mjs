// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Resolves changed executable coverage from the same verified Git ranges used for mutation. */
import { execFileSync } from 'node:child_process'
import { mutationLineRanges, nonExecutableDeletion } from './mutation-lines.mjs'

export function coverageLineRanges(root, comparison, subjects, files) {
  const selected = mutationLineRanges({ root, baseSha: comparison.base, headSha: comparison.head, subjects })
  for (const subject of subjects) {
    if (selected[subject] !== null) {
      const source = execFileSync('git', ['show', `${comparison.head}:${subject}`], {
        cwd: root,
        encoding: 'utf8',
      })
      selected[subject] = selected[subject].filter(
        ({ start, end }) => !nonExecutableDeletion(source, subject, start, end - start + 1),
      )
      continue
    }
    const existed = execFileSync(
      'git',
      ['--literal-pathspecs', 'ls-tree', '--name-only', comparison.base, '--', subject],
      { cwd: root, encoding: 'utf8' },
    ).trim()
    if (!existed) continue
    // Deletions cannot be covered at their old locations. Check each remaining containing
    // function; removing a complete function leaves no new executable lines to certify.
    const diff = execFileSync(
      'git',
      [
        '--literal-pathspecs',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--unified=0',
        comparison.base,
        comparison.head,
        '--',
        subject,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    selected[subject] = []
    for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]),
        count = Number(match[2] ?? 1)
      if (count) selected[subject].push({ start, end: start + count - 1 })
      else {
        const functions = Object.values(files[subject].fnMap).filter(
          ({ loc }) => loc.start.line < start && start < loc.end.line,
        )
        for (const { loc } of functions) selected[subject].push({ start: loc.start.line, end: loc.end.line })
      }
    }
  }
  return selected
}

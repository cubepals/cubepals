// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Git-anchored release ranges, using Stryker's native one-based inclusive line syntax. New
 * files and deletion-only hunks retain whole-file mutation coverage. Full audits bypass this
 * selector. The source on disk must equal the tested commit before any range can be trusted.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from './toolchain.mjs'

export function mutationLineRanges({ root, baseSha, headSha, subjects }) {
  if (![baseSha, headSha].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '')))
    throw new Error('Mutation line selection requires authoritative commit SHAs')
  const git = (...args) =>
    execFileSync('git', ['--literal-pathspecs', ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  if (git('rev-parse', '--verify', 'HEAD^{commit}').trim() !== headSha)
    throw new Error('Mutation line selection checkout differs from the tested head')
  return Object.fromEntries(
    subjects.map((subject) => {
      const source = git('show', `${headSha}:${subject}`)
      if (source !== readFileSync(resolve(root, subject), 'utf8'))
        throw new Error(`Mutation range source differs from Git: ${subject}`)
      const existed =
        execFileSync('git', ['--literal-pathspecs', 'ls-tree', '--name-only', baseSha, '--', subject], {
          cwd: root,
          encoding: 'utf8',
        }).trim() === subject
      if (!existed) return [subject, null]
      const diff = git(
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--no-color',
        '--unified=0',
        baseSha,
        headSha,
        '--',
        subject,
      )
      const ranges = []
      let baseSource
      for (const match of diff.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        const count = Number(match[3] ?? 1)
        if (count === 0) {
          baseSource ??= git('show', `${baseSha}:${subject}`)
          const oldStart = Number(match[0].match(/^@@ -(\d+)/)[1])
          const oldCount = Number(match[1] ?? 1)
          if (nonExecutableDeletion(baseSource, subject, oldStart, oldCount)) continue
          return [subject, null]
        }
        const start = Number(match[2])
        const end = start + count - 1
        if (start < 1 || end > source.split('\n').length)
          throw new Error(`Invalid Git mutation hunk: ${subject}`)
        const previous = ranges.at(-1)
        if (previous && start <= previous.end + 1) previous.end = end
        else ranges.push({ start, end })
      }
      return [subject, ranges]
    }),
  )
}

/** The same ranges drive independent enumeration and the actual pinned Stryker run. */
export function strykerMutationRanges(ranges) {
  return ranges == null
    ? true
    : ranges.map(({ start, end }) => ({
        start: { line: start - 1, column: 0 },
        end: { line: end - 1, column: Number.MAX_SAFE_INTEGER },
      }))
}

export function mutationPatterns(subject, ranges) {
  const literal = subject.replace(/[?*[\]{}()!+@]/g, (character) => `[${character}]`)
  if (ranges == null) return [literal]
  if (ranges.length === 0) return [`${literal}:1:0-1:0`]
  return ranges.map(({ start, end }) => `${literal}:${start}-${end}`)
}

export function mutationIdentity(mutant, zeroBased = false) {
  const position = ({ line, column }) => [line + (zeroBased ? 1 : 0), column + (zeroBased ? 1 : 0)]
  return JSON.stringify([
    mutant.mutatorName,
    mutant.replacement,
    position(mutant.location.start),
    position(mutant.location.end),
  ])
}

/** Skip only deleted lines wholly inside imports/types/comments, never mixed executable lines. */
export function nonExecutableDeletion(source, filename, start, count) {
  try {
    const ast = parse(source, {
      sourceType: 'module',
      plugins: filename.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    })
    const typeOnly = (node) =>
      ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction'].includes(node?.type)
    const ignored = [
      ...ast.comments,
      ...ast.program.body.filter(
        (node) =>
          node.type === 'ImportDeclaration' ||
          typeOnly(node) ||
          (node.type === 'ExportNamedDeclaration' &&
            (node.exportKind === 'type' || typeOnly(node.declaration))),
      ),
    ]
    const lines = source.split('\n')
    return Array.from({ length: count }, (_, offset) => start + offset).every((line) => {
      const text = lines[line - 1]
      return (
        text !== undefined &&
        (!text.trim() ||
          ignored.some(
            ({ loc }) =>
              loc.start.line <= line &&
              line <= loc.end.line &&
              (line > loc.start.line || !text.slice(0, loc.start.column).trim()) &&
              (line < loc.end.line || !text.slice(loc.end.column).trim()),
          ))
      )
    })
  } catch {
    return false
  }
}
